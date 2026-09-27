import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import type { ProposedRefund } from '@shared/policies/refund-policy';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import type {
  CreditRefundRepository,
  CreditRefundRequest,
  CreditRefundResult,
} from './credit-refunds.js';
import { recomputeInvoiceStatus } from './invoice-repo.js';

interface CreditRefundRow {
  id: string;
  credit_id: string;
  amount_cents: number;
  request_hash: string;
  payment_id: string;
}

/** Refund allocations, invoice reopening and new credit commit together. */
export class PostgresCreditRefundRepository implements CreditRefundRepository {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly now: () => Temporal.Instant = () => Temporal.Now.instant(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async replay(
    input: CreditRefundRequest,
    requestHash: string,
  ): Promise<CreditRefundResult | null> {
    this.assertOrg(input.orgId);
    return this.withOrg(this.context, async (trx) => {
      const result = await sql<CreditRefundRow>`
        SELECT id, credit_id, amount_cents, request_hash, payment_id
        FROM refunds WHERE org_id = ${input.orgId}::uuid
          AND credit_operation_key = ${input.idempotencyKey}::uuid
      `.execute(trx);
      const row = result.rows[0];
      if (!row) return null;
      return this.validateReplay(row, input, requestHash);
    });
  }

  async apply(
    input: CreditRefundRequest,
    requestHash: string,
    proposal: ProposedRefund,
  ): Promise<CreditRefundResult> {
    this.assertOrg(input.orgId);
    if (!Number.isSafeInteger(proposal.totalCents) || proposal.totalCents < 1)
      throw new Error('Credit refund amount must be positive cents');
    return this.withOrg(this.context, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select(['id', 'status', 'amount_cents'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.paymentId)
        .forUpdate()
        .executeTakeFirst();
      if (!payment || payment.status !== 'succeeded')
        throw new Error('Only a successful payment can become credit');
      const priorKey = await sql<CreditRefundRow>`
        SELECT id, credit_id, amount_cents, request_hash, payment_id
        FROM refunds WHERE org_id = ${input.orgId}::uuid
          AND credit_operation_key = ${input.idempotencyKey}::uuid
      `.execute(trx);
      if (priorKey.rows[0])
        return this.validateReplay(priorKey.rows[0], input, requestHash);
      const allocation = await trx
        .selectFrom('payment_allocations')
        .select(['invoice_id', 'amount_cents'])
        .where('org_id', '=', input.orgId)
        .where('payment_id', '=', input.paymentId)
        .execute();
      if (
        allocation.length !== 1 ||
        allocation[0]?.amount_cents !== payment.amount_cents
      )
        throw new Error('Payment allocation does not reconcile');
      const invoiceId = allocation[0].invoice_id;
      const invoice = await trx
        .selectFrom('invoices')
        .select(['account_id', 'household_id', 'status'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', invoiceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        invoice.status === 'void' ||
        (input.recipient === 'household' && !invoice.household_id)
      )
        throw new Error('Invoice cannot issue credit to this recipient');
      const prior = await sql<{ total: number }>`
        SELECT coalesce(sum(amount_cents), 0)::bigint AS total FROM refunds
        WHERE org_id = ${input.orgId}::uuid AND payment_id = ${input.paymentId}::uuid
          AND status IN ('pending', 'succeeded')
      `.execute(trx);
      if (
        proposal.totalCents + (prior.rows[0]?.total ?? 0) >
        payment.amount_cents
      )
        throw new Error('Refunds exceed the successful payment');
      const proposed = proposal.lines.filter((line) => line.amountCents > 0);
      if (
        new Set(proposed.map((line) => line.lineId)).size !== proposed.length ||
        proposed.reduce((sum, line) => sum + line.amountCents, 0) +
          proposal.serviceFeeCents !==
          proposal.totalCents
      )
        throw new Error('Credit refund allocations do not reconcile');
      const lines = proposed.map((line) => ({
        lineId: line.lineId,
        amountCents: line.amountCents,
      }));
      if (proposal.serviceFeeCents > 0) {
        const fees = await trx
          .selectFrom('invoice_lines')
          .select('id')
          .where('org_id', '=', input.orgId)
          .where('invoice_id', '=', invoiceId)
          .where('kind', '=', 'service_fee')
          .execute();
        if (fees.length !== 1 || !fees[0])
          throw new Error('Service fee line is unavailable');
        lines.push({
          lineId: fees[0].id,
          amountCents: proposal.serviceFeeCents,
        });
      }
      for (const line of lines) {
        const original = await trx
          .selectFrom('invoice_lines')
          .select('amount_cents')
          .where('org_id', '=', input.orgId)
          .where('invoice_id', '=', invoiceId)
          .where('id', '=', line.lineId)
          .executeTakeFirst();
        if (!original || line.amountCents < 1)
          throw new Error('Credit refund line is unavailable');
        const already = await sql<{ total: number }>`
          SELECT coalesce(sum(allocation.amount_cents), 0)::bigint AS total
          FROM refund_allocations allocation
          JOIN refunds refund ON refund.org_id = allocation.org_id
            AND refund.id = allocation.refund_id
          WHERE allocation.org_id = ${input.orgId}::uuid
            AND allocation.invoice_line_id = ${line.lineId}::uuid
            AND refund.status IN ('pending', 'succeeded')
        `.execute(trx);
        if (
          line.amountCents + (already.rows[0]?.total ?? 0) >
          original.amount_cents
        )
          throw new Error('Credit refund line exceeds remaining paid amount');
      }
      const accountId =
        input.recipient === 'account' ? invoice.account_id : null;
      const householdId =
        input.recipient === 'household' ? invoice.household_id : null;
      const creditId = newId();
      await sql`
        INSERT INTO credits
          (id, org_id, account_id, household_id, amount_cents, kind, source,
           invoice_id, created_by, operation_key, operation_line, request_hash)
        VALUES
          (${creditId}::uuid, ${input.orgId}::uuid, ${accountId}::uuid,
           ${householdId}::uuid, ${proposal.totalCents}, 'issued', 'refund_as_credit',
           ${invoiceId}::uuid, ${input.requestedByAccountId}::uuid,
           ${input.idempotencyKey}::uuid, 0, ${requestHash})
      `.execute(trx);
      const refundId = newId();
      await sql`
        INSERT INTO refunds
          (id, org_id, payment_id, amount_cents, reason, status,
           refund_application_fee, reverse_transfer, requested_by, approved_by,
           destination, credit_operation_key, request_hash, credit_id)
        VALUES
          (${refundId}::uuid, ${input.orgId}::uuid, ${input.paymentId}::uuid,
           ${proposal.totalCents}, 'withdrawal_policy', 'succeeded', false, false,
           ${input.requestedByAccountId}::uuid,
           ${input.approvedByAccountId ?? null}::uuid, 'credit',
           ${input.idempotencyKey}::uuid, ${requestHash}, ${creditId}::uuid)
      `.execute(trx);
      for (const line of lines) {
        await trx
          .insertInto('refund_allocations')
          .values({
            id: newId(),
            org_id: input.orgId,
            refund_id: refundId,
            invoice_line_id: line.lineId,
            amount_cents: line.amountCents,
          })
          .execute();
      }
      await trx
        .updateTable('invoices')
        .set({
          refunded_cents: sql`refunded_cents + ${proposal.totalCents}`,
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', invoiceId)
        .execute();
      const org = await trx
        .selectFrom('organizations')
        .select('timezone')
        .where('id', '=', input.orgId)
        .executeTakeFirstOrThrow();
      const todayLocal = this.now()
        .toZonedDateTimeISO(org.timezone)
        .toPlainDate()
        .toString();
      await recomputeInvoiceStatus(trx, input.orgId, invoiceId, todayLocal);
      await appendAuditEvent(trx, this.context, {
        action: 'refund.credited',
        entityType: 'refund',
        entityId: refundId,
        changes: {
          amountCents: { tier: 'internal', after: proposal.totalCents },
        },
      });
      return { refundId, creditId, amountCents: proposal.totalCents };
    });
  }

  private validateReplay(
    row: CreditRefundRow,
    input: CreditRefundRequest,
    requestHash: string,
  ): CreditRefundResult {
    if (row.request_hash !== requestHash || row.payment_id !== input.paymentId)
      throw new Error('Credit refund key conflicts with a different request');
    return {
      refundId: row.id,
      creditId: row.credit_id,
      amountCents: row.amount_cents,
    };
  }

  private assertOrg(orgId: string): void {
    if (orgId !== this.context.orgId)
      throw new Error('Credit refund organization mismatch');
  }
}
