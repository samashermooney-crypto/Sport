import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import type { PaymentRecordStore } from './service.js';

interface ExistingPayment {
  id: string;
  checkout_id: string;
  account_id: string;
  amount_cents: number;
  application_fee_cents: number;
  stripe_payment_intent_id: string;
  idempotency_key: string;
}

/** Stores checkout intents and their allocations before returning client secrets. */
export class PostgresPaymentRecordStore implements PaymentRecordStore {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async recordPending(input: {
    orgId: string;
    checkoutId: string;
    invoiceId: string;
    accountId: string;
    paymentIntentId: string;
    amountCents: number;
    applicationFeeCents: number;
    idempotencyKey: string;
  }): Promise<void> {
    if (input.orgId !== this.context.orgId)
      throw new Error('Payment organization mismatch');
    if (
      !Number.isSafeInteger(input.amountCents) ||
      input.amountCents < 1 ||
      !Number.isSafeInteger(input.applicationFeeCents) ||
      input.applicationFeeCents < 0 ||
      input.applicationFeeCents >= input.amountCents
    ) {
      throw new RangeError('Invalid pending payment cents');
    }
    await this.withOrg(this.context, async (trx) => {
      const existing = await sql<ExistingPayment>`
        SELECT id, checkout_id, account_id, amount_cents, application_fee_cents,
               stripe_payment_intent_id, idempotency_key
        FROM payments
        WHERE org_id = ${input.orgId}::uuid
          AND (stripe_payment_intent_id = ${input.paymentIntentId}
               OR idempotency_key = ${input.idempotencyKey}::uuid)
        FOR UPDATE
      `.execute(trx);
      if (existing.rows.length) {
        const recorded = existing.rows[0];
        if (!recorded) throw new Error('Payment record disappeared');
        if (
          existing.rows.length !== 1 ||
          recorded.checkout_id !== input.checkoutId ||
          recorded.account_id !== input.accountId ||
          recorded.amount_cents !== input.amountCents ||
          recorded.application_fee_cents !== input.applicationFeeCents ||
          recorded.stripe_payment_intent_id !== input.paymentIntentId ||
          recorded.idempotency_key !== input.idempotencyKey
        ) {
          throw new Error('Pending payment conflicts with an existing record');
        }
        const allocation = await trx
          .selectFrom('payment_allocations')
          .select(['invoice_id', 'amount_cents'])
          .where('org_id', '=', input.orgId)
          .where('payment_id', '=', recorded.id)
          .execute();
        const allocated = allocation[0];
        if (
          allocation.length !== 1 ||
          !allocated ||
          allocated.invoice_id !== input.invoiceId ||
          allocated.amount_cents !== input.amountCents
        ) {
          throw new Error('Pending payment allocation conflicts with invoice');
        }
        return;
      }
      const invoice = await trx
        .selectFrom('invoices')
        .select(['account_id', 'balance_cents', 'status'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.invoiceId)
        .forUpdate()
        .executeTakeFirst();
      const checkout = await trx
        .selectFrom('checkouts')
        .select(['account_id', 'status'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !invoice ||
        invoice.account_id !== input.accountId ||
        !checkout ||
        checkout.account_id !== input.accountId ||
        checkout.status !== 'awaiting_payment' ||
        ['draft', 'void', 'paid', 'uncollectible'].includes(invoice.status)
      ) {
        throw new Error('Frozen checkout invoice is unavailable');
      }
      const pending = await sql<{ total: number }>`
        SELECT coalesce(sum(allocation.amount_cents), 0)::bigint AS total
        FROM payment_allocations allocation
        JOIN payments payment
          ON payment.org_id = allocation.org_id AND payment.id = allocation.payment_id
        WHERE allocation.org_id = ${input.orgId}::uuid
          AND allocation.invoice_id = ${input.invoiceId}::uuid
          AND payment.status IN ('requires_action', 'processing')
      `.execute(trx);
      if (
        invoice.balance_cents === null ||
        input.amountCents + (pending.rows[0]?.total ?? 0) >
          invoice.balance_cents
      ) {
        throw new Error('Pending payments exceed invoice balance');
      }
      const paymentId = newId();
      await sql`
        INSERT INTO payments
          (id, org_id, account_id, checkout_id, method, status, amount_cents,
           application_fee_cents, stripe_payment_intent_id, idempotency_key)
        VALUES
          (${paymentId}::uuid, ${input.orgId}::uuid, ${input.accountId}::uuid,
           ${input.checkoutId}::uuid, 'unknown', 'requires_action',
           ${input.amountCents}, ${input.applicationFeeCents},
           ${input.paymentIntentId}, ${input.idempotencyKey}::uuid)
      `.execute(trx);
      await trx
        .insertInto('payment_allocations')
        .values({
          id: newId(),
          org_id: input.orgId,
          payment_id: paymentId,
          invoice_id: input.invoiceId,
          installment_id: null,
          amount_cents: input.amountCents,
        })
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'payment.intent_recorded',
        entityType: 'payment',
        entityId: paymentId,
        changes: {
          amountCents: { tier: 'internal', after: input.amountCents },
        },
      });
    });
  }
}
