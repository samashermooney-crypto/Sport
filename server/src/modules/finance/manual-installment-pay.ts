import { createHash } from 'node:crypto';

import { applicationFee } from '@shared/algorithms/fees';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { appendAuditEvent } from '../audit/service.js';

import { allocatePaymentLines } from './payment-line-allocations.js';

export const manualInstallmentIntentSchema = z.strictObject({
  id: z.string().startsWith('pi_'),
  clientSecret: z.string().min(1),
  status: z.string().min(1),
  amountCents: z.number().int().positive(),
  applicationFeeCents: z.number().int().nonnegative(),
});
export const manualInstallmentListSchema = z.strictObject({
  installments: z.array(
    z.strictObject({
      id: z.uuid(),
      invoiceId: z.uuid(),
      invoiceNumber: z.number().int().positive(),
      dueOn: z.iso.date(),
      outstandingCents: z.number().int().positive(),
      status: z.enum(['scheduled', 'failed']),
    }),
  ),
});
export type ManualInstallmentIntent = z.output<
  typeof manualInstallmentIntentSchema
>;
export class ManualInstallmentConflictError extends Error {}

interface Claim {
  installment_id: string;
  invoice_id: string;
  payment_id: string;
  account_id: string;
  amount_cents: number;
  application_fee_cents: number;
  customer_id: string;
  connected_account_id: string;
}
interface Existing extends Claim {
  request_hash: string;
  status: string;
  result: unknown;
}

/** A payer-initiated charge is reserved and allocated before any Stripe call. */
export class PostgresManualInstallmentPayments {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly gateway: Pick<
      PaymentsGateway,
      'retrieveAccount' | 'createDestinationPayment'
    > | null = null,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async listPayable(): Promise<z.output<typeof manualInstallmentListSchema>> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<{
        id: string;
        invoice_id: string;
        invoice_number: number;
        due_on: string;
        outstanding_cents: number;
        status: string;
      }>`
        SELECT inst.id, inst.invoice_id, i.number AS invoice_number,
          inst.due_on::text, inst.amount_cents - inst.paid_cents
            AS outstanding_cents, inst.status
        FROM installments inst JOIN invoices i
          ON i.org_id = inst.org_id AND i.id = inst.invoice_id
        JOIN payer_profiles profile ON profile.account_id = i.account_id
          AND profile.stripe_customer_id IS NOT NULL
        JOIN payment_accounts pa ON pa.org_id = inst.org_id
          AND pa.charges_enabled = true AND pa.stripe_account_id IS NOT NULL
        WHERE inst.org_id = ${this.context.orgId}::uuid
          AND i.account_id = ${this.context.actor.accountId}::uuid
          AND i.status IN ('open', 'partially_paid', 'past_due')
          AND i.balance_cents > 0
          AND i.disputed_cents = 0
          AND inst.status IN ('scheduled', 'failed')
          AND inst.amount_cents > inst.paid_cents
          AND NOT EXISTS (
            SELECT 1 FROM payment_allocations pa JOIN payments p
              ON p.org_id = pa.org_id AND p.id = pa.payment_id
            WHERE pa.org_id = inst.org_id AND pa.installment_id = inst.id
              AND p.status IN ('requires_action', 'processing'))
        ORDER BY inst.due_on, inst.id LIMIT 100
      `.execute(trx);
      return manualInstallmentListSchema.parse({
        installments: rows.rows.map((row) => ({
          id: row.id,
          invoiceId: row.invoice_id,
          invoiceNumber: row.invoice_number,
          dueOn: row.due_on,
          outstandingCents: row.outstanding_cents,
          status: row.status,
        })),
      });
    });
  }

  async create(
    installmentId: string,
    operationKey: string,
  ): Promise<ManualInstallmentIntent> {
    const gateway = this.gateway;
    if (!gateway)
      throw new ManualInstallmentConflictError(
        'Payment gateway is unavailable',
      );
    const id = z.uuid().parse(installmentId);
    const key = z.uuid().parse(operationKey);
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          orgId: this.context.orgId,
          installmentId: id,
          accountId: this.context.actor.accountId,
        }),
      )
      .digest('hex');
    const reserved = await this.withOrg(this.context, async (trx) => {
      const installment = await trx
        .selectFrom('installments')
        .select(['id', 'invoice_id', 'amount_cents', 'paid_cents', 'status'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!installment)
        throw new ManualInstallmentConflictError('Installment is unavailable');
      const invoice = await trx
        .selectFrom('invoices')
        .select(['account_id', 'balance_cents', 'status', 'disputed_cents'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', installment.invoice_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (invoice.account_id !== this.context.actor.accountId)
        throw new ManualInstallmentConflictError(
          'Installment belongs to another payer',
        );
      const prior = await sql<Existing>`
        SELECT a.request_hash, a.status, a.result, a.installment_id,
          i.invoice_id, a.payment_id, a.account_id, a.amount_cents,
          a.application_fee_cents, a.customer_id, a.connected_account_id
        FROM manual_installment_payment_attempts a
        JOIN installments i ON i.org_id = a.org_id AND i.id = a.installment_id
        WHERE a.org_id = ${this.context.orgId}::uuid
          AND a.operation_key = ${key}::uuid
        FOR UPDATE OF a
      `.execute(trx);
      const existing = prior.rows[0];
      if (existing) {
        if (existing.request_hash !== hash || existing.installment_id !== id)
          throw new ManualInstallmentConflictError('Payment key was reused');
        if (existing.status === 'completed') {
          const payment = await trx
            .selectFrom('payments')
            .select('status')
            .where('org_id', '=', this.context.orgId)
            .where('id', '=', existing.payment_id)
            .executeTakeFirstOrThrow();
          if (['failed', 'canceled'].includes(payment.status))
            throw new ManualInstallmentConflictError(
              'Previous payment failed; start a new attempt',
            );
          return {
            kind: 'replay' as const,
            result: manualInstallmentIntentSchema.parse(existing.result),
          };
        }
        if (existing.status === 'failed_pre_external')
          throw new ManualInstallmentConflictError(
            'Payment preparation failed; start a new attempt',
          );
        if (existing.status !== 'reserved')
          throw new ManualInstallmentConflictError(
            'Payment is being reconciled',
          );
        return { kind: 'claim' as const, claim: existing };
      }
      if (
        !['scheduled', 'failed'].includes(installment.status) ||
        installment.amount_cents <= installment.paid_cents ||
        !['open', 'partially_paid', 'past_due'].includes(invoice.status) ||
        invoice.disputed_cents > 0 ||
        !invoice.balance_cents
      )
        throw new ManualInstallmentConflictError('Installment is not payable');
      const amountCents = installment.amount_cents - installment.paid_cents;
      const active = await sql<{ amount: number; claimed: boolean }>`
        SELECT
          (SELECT coalesce(sum(pa.amount_cents), 0)::bigint
           FROM payment_allocations pa JOIN payments p
             ON p.org_id = pa.org_id AND p.id = pa.payment_id
           WHERE pa.org_id = ${this.context.orgId}::uuid
             AND pa.invoice_id = ${installment.invoice_id}::uuid
             AND p.status IN ('requires_action', 'processing')) AS amount,
          EXISTS (SELECT 1 FROM installment_charge_attempts a
            WHERE a.org_id = ${this.context.orgId}::uuid
              AND a.installment_id = ${id}::uuid
              AND a.status IN ('reserved', 'external_started')) AS claimed
      `.execute(trx);
      if (
        active.rows[0]?.claimed ||
        amountCents + (active.rows[0]?.amount ?? 0) > invoice.balance_cents
      )
        throw new ManualInstallmentConflictError(
          'A payment is already in progress',
        );
      const already = await sql<{ active: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM payment_allocations pa JOIN payments p
            ON p.org_id = pa.org_id AND p.id = pa.payment_id
          WHERE pa.org_id = ${this.context.orgId}::uuid
            AND pa.installment_id = ${id}::uuid
            AND p.status IN ('requires_action', 'processing')
        ) AS active
      `.execute(trx);
      if (already.rows[0]?.active)
        throw new ManualInstallmentConflictError(
          'Installment payment is in progress',
        );
      const profile = await trx
        .selectFrom('payer_profiles')
        .select('stripe_customer_id')
        .where('account_id', '=', this.context.actor.accountId)
        .executeTakeFirst();
      const paymentAccount = await trx
        .selectFrom('payment_accounts')
        .select(['stripe_account_id', 'charges_enabled'])
        .where('org_id', '=', this.context.orgId)
        .executeTakeFirst();
      if (
        !profile?.stripe_customer_id ||
        !paymentAccount?.stripe_account_id ||
        !paymentAccount.charges_enabled
      )
        throw new ManualInstallmentConflictError(
          'Payment setup is unavailable',
        );
      const org = await trx
        .selectFrom('organizations')
        .select(['application_fee_bps', 'application_fee_fixed_cents'])
        .where('id', '=', this.context.orgId)
        .executeTakeFirstOrThrow();
      const applicationFeeCents = applicationFee(amountCents, {
        bps: org.application_fee_bps,
        fixedCents: org.application_fee_fixed_cents,
      });
      const paymentId = newId();
      await trx
        .insertInto('payments')
        .values({
          id: paymentId,
          org_id: this.context.orgId,
          account_id: this.context.actor.accountId,
          method: 'unknown',
          status: 'requires_action',
          amount_cents: amountCents,
          application_fee_cents: applicationFeeCents,
          idempotency_key: key,
        })
        .execute();
      await trx
        .insertInto('payment_allocations')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          payment_id: paymentId,
          invoice_id: installment.invoice_id,
          installment_id: id,
          amount_cents: amountCents,
        })
        .execute();
      await allocatePaymentLines(trx, {
        orgId: this.context.orgId,
        invoiceId: installment.invoice_id,
        paymentId,
        amountCents,
      });
      await sql`
        INSERT INTO manual_installment_payment_attempts
          (id, org_id, installment_id, account_id, operation_key,
           request_hash, status, payment_id, amount_cents,
           application_fee_cents, customer_id, connected_account_id)
        VALUES (${newId()}::uuid, ${this.context.orgId}::uuid, ${id}::uuid,
          ${this.context.actor.accountId}::uuid, ${key}::uuid,
          ${hash}, 'reserved', ${paymentId}::uuid, ${amountCents},
          ${applicationFeeCents}, ${profile.stripe_customer_id},
          ${paymentAccount.stripe_account_id})
      `.execute(trx);
      return {
        kind: 'claim' as const,
        claim: {
          installment_id: id,
          invoice_id: installment.invoice_id,
          payment_id: paymentId,
          account_id: this.context.actor.accountId,
          amount_cents: amountCents,
          application_fee_cents: applicationFeeCents,
          customer_id: profile.stripe_customer_id,
          connected_account_id: paymentAccount.stripe_account_id,
        } satisfies Claim,
      };
    });
    if (reserved.kind === 'replay') return reserved.result;
    const claim = reserved.claim;
    let account;
    try {
      account = await gateway.retrieveAccount(claim.connected_account_id);
    } catch (error) {
      await this.failBeforeExternal(key, claim.payment_id);
      throw error;
    }
    if (
      account.id !== claim.connected_account_id ||
      !account.chargesEnabled ||
      (account.orgId && account.orgId !== this.context.orgId)
    ) {
      await this.failBeforeExternal(key, claim.payment_id);
      throw new ManualInstallmentConflictError(
        'Connected account cannot charge',
      );
    }
    await this.withOrg(this.context, async (trx) => {
      const changed = await sql<{ id: string }>`
        UPDATE manual_installment_payment_attempts
        SET status = 'external_started', updated_at = now()
        WHERE org_id = ${this.context.orgId}::uuid
          AND operation_key = ${key}::uuid AND status = 'reserved'
        RETURNING id
      `.execute(trx);
      if (!changed.rows[0])
        throw new ManualInstallmentConflictError('Payment claim changed');
    });
    const intent = await gateway.createDestinationPayment({
      orgId: this.context.orgId,
      installmentId: id,
      invoiceId: claim.invoice_id,
      amountCents: claim.amount_cents,
      applicationFeeCents: claim.application_fee_cents,
      customerId: claim.customer_id,
      connectedAccountId: claim.connected_account_id,
      idempotencyKey: `manual-inst:${id}:${key}`,
      saveForAutopay: false,
    });
    if (intent.amountCents !== claim.amount_cents || !intent.clientSecret)
      throw new ManualInstallmentConflictError(
        'Stripe payment amount or secret differs',
      );
    const result = manualInstallmentIntentSchema.parse({
      id: intent.id,
      clientSecret: intent.clientSecret,
      status: intent.status,
      amountCents: claim.amount_cents,
      applicationFeeCents: claim.application_fee_cents,
    });
    await this.withOrg(this.context, async (trx) => {
      await trx
        .updateTable('payments')
        .set({ stripe_payment_intent_id: result.id })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', claim.payment_id)
        .execute();
      await sql`
        UPDATE manual_installment_payment_attempts
        SET status = 'completed', result = ${JSON.stringify(result)}::jsonb,
            updated_at = now()
        WHERE org_id = ${this.context.orgId}::uuid
          AND operation_key = ${key}::uuid AND status = 'external_started'
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'installment.manual_payment_intent',
        entityType: 'installment',
        entityId: id,
        changes: {
          paymentId: { tier: 'internal', after: claim.payment_id },
          amountCents: { tier: 'internal', after: claim.amount_cents },
        },
      });
    });
    return result;
  }

  private async failBeforeExternal(
    key: string,
    paymentId: string,
  ): Promise<void> {
    await this.withOrg(this.context, async (trx) => {
      const changed = await sql<{ id: string }>`
        UPDATE manual_installment_payment_attempts
        SET status = 'failed_pre_external', updated_at = now()
        WHERE org_id = ${this.context.orgId}::uuid
          AND operation_key = ${key}::uuid AND status = 'reserved'
        RETURNING id
      `.execute(trx);
      if (changed.rows[0])
        await trx
          .updateTable('payments')
          .set({ status: 'canceled' })
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', paymentId)
          .execute();
    });
  }
}
