import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import { assertPaymentFundsRefund } from './payment-line-allocations.js';
import type { RefundRecordStore } from './refunds.js';

/** Records the external refund and every line allocation before webhook settlement. */
export class PostgresRefundRecordStore implements RefundRecordStore {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async recordPending(
    input: Parameters<RefundRecordStore['recordPending']>[0],
  ): Promise<void> {
    if (input.orgId !== this.context.orgId)
      throw new Error('Refund organization mismatch');
    if (
      !input.refundId.startsWith('re_') ||
      !Number.isSafeInteger(input.proposal.totalCents) ||
      input.proposal.totalCents < 1
    )
      throw new Error('Invalid Stripe refund result');
    await this.withOrg(this.context, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select(['id', 'amount_cents', 'status'])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.paymentId)
        .forUpdate()
        .executeTakeFirst();
      if (!payment || payment.status !== 'succeeded')
        throw new Error('Only a successful payment can be refunded');
      const existing = await trx
        .selectFrom('refunds')
        .select(['id', 'payment_id', 'amount_cents', 'refund_application_fee'])
        .where('org_id', '=', input.orgId)
        .where('stripe_refund_id', '=', input.refundId)
        .executeTakeFirst();
      const proposed = input.proposal.lines.filter(
        (line) => line.amountCents > 0,
      );
      const allocatedTotal =
        proposed.reduce((sum, line) => sum + line.amountCents, 0) +
        input.proposal.serviceFeeCents;
      if (
        allocatedTotal !== input.proposal.totalCents ||
        new Set(proposed.map((line) => line.lineId)).size !== proposed.length
      )
        throw new Error('Refund proposal allocations do not reconcile');
      if (existing) {
        const lines = await trx
          .selectFrom('refund_allocations')
          .select(['invoice_line_id', 'amount_cents'])
          .where('org_id', '=', input.orgId)
          .where('refund_id', '=', existing.id)
          .execute();
        const original = [
          ...proposed.map((line) => [line.lineId, line.amountCents] as const),
        ];
        const extras = lines.filter(
          (line) => !original.some(([id]) => id === line.invoice_line_id),
        );
        const serviceFee =
          extras.length === 1 && extras[0]
            ? await trx
                .selectFrom('invoice_lines')
                .select('kind')
                .where('org_id', '=', input.orgId)
                .where('id', '=', extras[0].invoice_line_id)
                .executeTakeFirst()
            : null;
        const matching =
          lines.length ===
            original.length + (input.proposal.serviceFeeCents > 0 ? 1 : 0) &&
          original.every(([id, cents]) =>
            lines.some(
              (line) =>
                line.invoice_line_id === id && line.amount_cents === cents,
            ),
          ) &&
          (input.proposal.serviceFeeCents === 0
            ? extras.length === 0
            : extras[0]?.amount_cents === input.proposal.serviceFeeCents &&
              serviceFee?.kind === 'service_fee');
        if (
          existing.payment_id !== input.paymentId ||
          existing.amount_cents !== input.proposal.totalCents ||
          existing.refund_application_fee !== input.refundApplicationFee ||
          !matching
        )
          throw new Error('Stripe refund conflicts with a recorded refund');
        return;
      }
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
        throw new Error('Payment allocation does not reconcile for refund');
      const invoiceId = allocation[0].invoice_id;
      const prior = await sql<{ total: number }>`
        SELECT coalesce(sum(amount_cents), 0)::bigint AS total
        FROM refunds WHERE org_id = ${input.orgId}::uuid
          AND payment_id = ${input.paymentId}::uuid
          AND status IN ('pending', 'succeeded')
      `.execute(trx);
      if (
        input.proposal.totalCents + (prior.rows[0]?.total ?? 0) >
        payment.amount_cents
      )
        throw new Error('Refunds exceed the successful payment');
      const ids = proposed.map((line) => line.lineId);
      const lines = ids.length
        ? await trx
            .selectFrom('invoice_lines')
            .select(['id', 'amount_cents'])
            .where('org_id', '=', input.orgId)
            .where('invoice_id', '=', invoiceId)
            .where('id', 'in', ids)
            .execute()
        : [];
      if (lines.length !== ids.length)
        throw new Error('Refund line is not on the paid invoice');
      const mapped = proposed.map((line) => ({
        lineId: line.lineId,
        amountCents: line.amountCents,
      }));
      if (input.proposal.serviceFeeCents > 0) {
        const fees = await trx
          .selectFrom('invoice_lines')
          .select(['id', 'amount_cents'])
          .where('org_id', '=', input.orgId)
          .where('invoice_id', '=', invoiceId)
          .where('kind', '=', 'service_fee')
          .execute();
        if (fees.length !== 1 || !fees[0])
          throw new Error('Refundable service fee line is unavailable');
        mapped.push({
          lineId: fees[0].id,
          amountCents: input.proposal.serviceFeeCents,
        });
      }
      for (const line of mapped) {
        const original = await trx
          .selectFrom('invoice_lines')
          .select('amount_cents')
          .where('org_id', '=', input.orgId)
          .where('invoice_id', '=', invoiceId)
          .where('id', '=', line.lineId)
          .executeTakeFirstOrThrow();
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
          line.amountCents < 1 ||
          line.amountCents + (already.rows[0]?.total ?? 0) >
            original.amount_cents
        )
          throw new Error('Refund line exceeds its remaining paid amount');
      }
      await assertPaymentFundsRefund(trx, {
        orgId: input.orgId,
        paymentId: input.paymentId,
        invoiceId,
        paymentAmountCents: payment.amount_cents,
        lines: mapped,
      });
      const refundId = newId();
      await trx
        .insertInto('refunds')
        .values({
          id: refundId,
          org_id: input.orgId,
          payment_id: input.paymentId,
          amount_cents: input.proposal.totalCents,
          reason: input.reason ?? 'withdrawal_policy',
          note: input.note ?? null,
          status: 'pending',
          stripe_refund_id: input.refundId,
          refund_application_fee: input.refundApplicationFee,
          reverse_transfer: true,
          requested_by: input.requestedByAccountId,
          approved_by: input.approvedByAccountId,
        })
        .execute();
      for (const line of mapped) {
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
      await appendAuditEvent(trx, this.context, {
        action: 'refund.intent_recorded',
        entityType: 'refund',
        entityId: refundId,
        changes: {
          amountCents: { tier: 'internal', after: input.proposal.totalCents },
        },
      });
    });
  }
}
