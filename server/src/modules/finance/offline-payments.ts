import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import { allocateOrgNumber } from '../../db/orgCounters.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import { recomputeInvoiceStatus } from './invoice-repo.js';

export interface OfflinePaymentInput {
  orgId: string;
  invoiceId: string;
  method: 'cash' | 'check' | 'external';
  amountCents: number;
  reference: string | null;
  idempotencyKey: string;
}

export interface OfflinePaymentReceipt {
  paymentId: string;
  receiptNumber: number;
  amountCents: number;
}

interface StoredPayment {
  id: string;
  receipt_number: number | null;
  amount_cents: number;
  method: string;
  reference: string | null;
  received_by: string | null;
  invoice_id: string;
}

/** Finance-staff cash/check/external receipt with one invoice allocation. */
export class PostgresOfflinePayments {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async record(input: OfflinePaymentInput): Promise<OfflinePaymentReceipt> {
    if (input.orgId !== this.context.orgId)
      throw new Error('Offline payment organization mismatch');
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1)
      throw new RangeError('Offline payment must be positive integer cents');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.idempotencyKey,
      )
    )
      throw new Error('Offline payment idempotency key must be a UUID');
    const reference = input.reference?.trim() || null;
    if ((input.method === 'check' || input.method === 'external') && !reference)
      throw new Error('Check and external payments require a reference');
    if (reference && reference.length > 200)
      throw new Error('Offline payment reference is too long');
    return this.withOrg(this.context, async (trx) => {
      const invoice = await trx
        .selectFrom('invoices')
        .select(['account_id', 'balance_cents', 'status'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.invoiceId)
        .forUpdate()
        .executeTakeFirst();
      if (!invoice) throw new Error('Invoice does not belong to organization');
      const existing = await sql<StoredPayment>`
        SELECT p.id, p.receipt_number, p.amount_cents, p.method,
          p.reference, p.received_by, pa.invoice_id
        FROM payments p JOIN payment_allocations pa
          ON pa.org_id = p.org_id AND pa.payment_id = p.id
        WHERE p.org_id = ${input.orgId}::uuid
          AND p.idempotency_key = ${input.idempotencyKey}::uuid
        FOR UPDATE OF p
      `.execute(trx);
      if (existing.rows[0]) {
        const payment = existing.rows[0];
        if (
          existing.rows.length !== 1 ||
          !payment.receipt_number ||
          payment.method !== input.method ||
          payment.amount_cents !== input.amountCents ||
          payment.reference !== reference ||
          payment.invoice_id !== input.invoiceId ||
          payment.received_by !== this.context.actor.accountId
        )
          throw new Error(
            'Offline payment idempotency key conflicts with prior record',
          );
        return {
          paymentId: payment.id,
          receiptNumber: payment.receipt_number,
          amountCents: payment.amount_cents,
        };
      }
      if (invoice.status === 'draft' || invoice.status === 'void')
        throw new Error('Cannot collect an offline payment on this invoice');
      const pending = await sql<{ total: number }>`
        SELECT coalesce(sum(pa.amount_cents), 0)::bigint AS total
        FROM payment_allocations pa JOIN payments p
          ON p.org_id = pa.org_id AND p.id = pa.payment_id
        WHERE pa.org_id = ${input.orgId}::uuid
          AND pa.invoice_id = ${input.invoiceId}::uuid
          AND p.status IN ('requires_action', 'processing')
      `.execute(trx);
      if (
        invoice.balance_cents === null ||
        input.amountCents + (pending.rows[0]?.total ?? 0) >
          invoice.balance_cents
      )
        throw new Error('Offline payment exceeds available invoice balance');
      const paymentId = newId();
      const receiptNumber = await allocateOrgNumber(
        trx,
        input.orgId,
        'receipt',
      );
      await sql`
        INSERT INTO payments (id, org_id, account_id, method, status,
          amount_cents, application_fee_cents, processing_fee_cents,
          net_cents, reference, received_by, idempotency_key,
          succeeded_at, receipt_number)
        VALUES (${paymentId}::uuid, ${input.orgId}::uuid,
          ${invoice.account_id}::uuid, ${input.method}, 'succeeded',
          ${input.amountCents}, 0, 0, ${input.amountCents}, ${reference},
          ${this.context.actor.accountId}::uuid, ${input.idempotencyKey}::uuid,
          now(), ${receiptNumber})
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
      await trx
        .updateTable('invoices')
        .set({
          paid_cents: sql`paid_cents + ${input.amountCents}`,
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.invoiceId)
        .execute();
      const org = await trx
        .selectFrom('organizations')
        .select('timezone')
        .where('id', '=', input.orgId)
        .executeTakeFirstOrThrow();
      const todayLocal = Temporal.Now.instant()
        .toZonedDateTimeISO(org.timezone)
        .toPlainDate()
        .toString();
      await recomputeInvoiceStatus(
        trx,
        input.orgId,
        input.invoiceId,
        todayLocal,
      );
      await appendAuditEvent(trx, this.context, {
        action: 'payment.offline_recorded',
        entityType: 'payment',
        entityId: paymentId,
        changes: {
          amountCents: {
            tier: 'internal',
            before: null,
            after: input.amountCents,
          },
          method: { tier: 'internal', before: null, after: input.method },
        },
      });
      return { paymentId, receiptNumber, amountCents: input.amountCents };
    });
  }
}
