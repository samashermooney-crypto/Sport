import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { GatewayDispute } from '../../integrations/stripe/gateway.js';
import { appendAuditEvent } from '../audit/service.js';

import { recomputeInvoiceStatus } from './invoice-repo.js';

type AccountingState = 'warning' | 'active' | 'won' | 'lost';

function accountingState(dispute: GatewayDispute): AccountingState {
  if (dispute.status === 'lost') return 'lost';
  if (dispute.status === 'won' || dispute.status === 'prevented') return 'won';
  if (
    dispute.fundsWithdrawn &&
    (dispute.status === 'needs_response' || dispute.status === 'under_review')
  )
    return 'active';
  return 'warning';
}

/** Mirrors latest dispute facts and adjusts collectible invoice cents once. */
export class PostgresDisputeRepository {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly actorAccountId: string,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async applyLatest(
    orgId: string,
    latest: GatewayDispute,
  ): Promise<'applied' | 'unchanged'> {
    if (!latest.id.startsWith('dp_') || !latest.chargeId.startsWith('ch_'))
      throw new Error('Invalid Stripe dispute identity');
    if (
      !Number.isSafeInteger(latest.amountCents) ||
      latest.amountCents < 1 ||
      !Number.isSafeInteger(latest.feeCents) ||
      latest.feeCents < 0
    )
      throw new Error('Invalid Stripe dispute cents');
    const context: OrgContext = {
      orgId,
      actor: { accountId: this.actorAccountId },
    };
    return this.withOrg(context, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select(['id', 'amount_cents', 'status', 'stripe_payment_intent_id'])
        .where('org_id', '=', orgId)
        .where('stripe_charge_id', '=', latest.chargeId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !payment ||
        payment.status !== 'succeeded' ||
        (latest.paymentIntentId &&
          payment.stripe_payment_intent_id !== latest.paymentIntentId) ||
        latest.amountCents > payment.amount_cents
      )
        throw new Error(
          'Stripe dispute does not match a successful org payment',
        );
      const allocations = await trx
        .selectFrom('payment_allocations')
        .select(['invoice_id', 'amount_cents'])
        .where('org_id', '=', orgId)
        .where('payment_id', '=', payment.id)
        .execute();
      if (
        allocations.length !== 1 ||
        allocations[0]?.amount_cents !== payment.amount_cents
      )
        throw new Error('Disputed payment allocation does not reconcile');
      const invoiceId = allocations[0].invoice_id;
      const invoice = await sql<{
        disputed_cents: number;
        dispute_lost_cents: number;
        paid_cents: number;
        refunded_cents: number;
      }>`
        SELECT disputed_cents, dispute_lost_cents, paid_cents, refunded_cents
        FROM invoices WHERE org_id = ${orgId}::uuid AND id = ${invoiceId}::uuid
        FOR UPDATE
      `.execute(trx);
      if (!invoice.rows[0]) throw new Error('Disputed invoice not found');
      const existing = await sql<{
        id: string;
        accounting_state: AccountingState;
        amount_cents: number;
        fee_cents: number;
        status: string;
        payment_id: string;
        invoice_id: string | null;
        stripe_charge_id: string | null;
        stripe_transfer_id: string | null;
        reason: string | null;
        evidence_due_by: Date | null;
        funds_withdrawn: boolean;
        funds_reinstated: boolean;
      }>`
        SELECT id, accounting_state, amount_cents, fee_cents, status,
          payment_id, invoice_id, stripe_charge_id, stripe_transfer_id,
          reason, evidence_due_by, funds_withdrawn, funds_reinstated
        FROM disputes WHERE org_id = ${orgId}::uuid
          AND stripe_dispute_id = ${latest.id} FOR UPDATE
      `.execute(trx);
      const old = existing.rows[0];
      const disputeRecordId = old?.id ?? newId();
      if (old && old.amount_cents !== latest.amountCents)
        throw new Error('Stripe dispute amount changed after recording');
      if (
        old &&
        (old.payment_id !== payment.id ||
          old.invoice_id !== invoiceId ||
          old.stripe_charge_id !== latest.chargeId)
      )
        throw new Error('Stripe dispute payment ownership changed');
      const target = accountingState(latest);
      if (
        old &&
        (old.accounting_state === 'won' || old.accounting_state === 'lost') &&
        target !== old.accounting_state
      )
        throw new Error('Terminal dispute accounting state cannot regress');
      const previous = old?.accounting_state ?? 'warning';
      const wasActive = previous === 'active' ? latest.amountCents : 0;
      const isActive = target === 'active' ? latest.amountCents : 0;
      const wasLost = previous === 'lost' ? latest.amountCents : 0;
      const isLost = target === 'lost' ? latest.amountCents : 0;
      const disputedCents =
        invoice.rows[0].disputed_cents + isActive - wasActive;
      const lostCents = invoice.rows[0].dispute_lost_cents + isLost - wasLost;
      if (
        disputedCents < 0 ||
        lostCents < 0 ||
        disputedCents + lostCents + invoice.rows[0].refunded_cents >
          invoice.rows[0].paid_cents
      )
        throw new Error('Dispute exceeds collectible paid invoice cents');
      const evidenceDueBy = latest.evidenceDueBy
        ? new Date(latest.evidenceDueBy * 1000)
        : null;
      if (
        old &&
        old.accounting_state === target &&
        old.status === latest.status &&
        old.fee_cents === latest.feeCents &&
        old.reason === latest.reason &&
        old.stripe_transfer_id === latest.transferId &&
        old.evidence_due_by?.getTime() === evidenceDueBy?.getTime() &&
        old.funds_withdrawn === latest.fundsWithdrawn &&
        old.funds_reinstated === latest.fundsReinstated
      )
        return 'unchanged';
      if (!old) {
        await sql`
          INSERT INTO disputes (id, org_id, payment_id, invoice_id,
            stripe_dispute_id, stripe_charge_id, stripe_transfer_id,
            status, reason, amount_cents, fee_cents, evidence_due_by,
            funds_withdrawn, funds_reinstated, accounting_state)
          VALUES (${disputeRecordId}::uuid, ${orgId}::uuid, ${payment.id}::uuid,
            ${invoiceId}::uuid, ${latest.id}, ${latest.chargeId},
            ${latest.transferId}, ${latest.status}, ${latest.reason},
            ${latest.amountCents}, ${latest.feeCents},
            ${evidenceDueBy},
            ${latest.fundsWithdrawn}, ${latest.fundsReinstated}, ${target})
        `.execute(trx);
      } else {
        await sql`
          UPDATE disputes SET status = ${latest.status}, reason = ${latest.reason},
            fee_cents = ${latest.feeCents},
            stripe_transfer_id = ${latest.transferId},
            evidence_due_by = ${evidenceDueBy},
            funds_withdrawn = ${latest.fundsWithdrawn},
            funds_reinstated = ${latest.fundsReinstated},
            accounting_state = ${target}, version = version + 1
          WHERE org_id = ${orgId}::uuid AND id = ${old.id}::uuid
        `.execute(trx);
      }
      if (
        disputedCents !== invoice.rows[0].disputed_cents ||
        lostCents !== invoice.rows[0].dispute_lost_cents
      ) {
        await sql`
          UPDATE invoices SET disputed_cents = ${disputedCents},
            dispute_lost_cents = ${lostCents}, version = version + 1
          WHERE org_id = ${orgId}::uuid AND id = ${invoiceId}::uuid
        `.execute(trx);
        const org = await trx
          .selectFrom('organizations')
          .select('timezone')
          .where('id', '=', orgId)
          .executeTakeFirstOrThrow();
        const todayLocal = Temporal.Now.instant()
          .toZonedDateTimeISO(org.timezone)
          .toPlainDate()
          .toString();
        await recomputeInvoiceStatus(trx, orgId, invoiceId, todayLocal);
      }
      await appendAuditEvent(trx, context, {
        action: `dispute.${target}`,
        entityType: 'dispute',
        entityId: disputeRecordId,
        changes: {
          status: { tier: 'internal', before: previous, after: target },
        },
      });
      return 'applied';
    });
  }
}
