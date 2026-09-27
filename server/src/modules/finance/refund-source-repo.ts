import type { RefundableLine } from '@shared/policies/refund-policy';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';

import { refundTermsSchema } from './refund-terms.js';
import {
  RefundConflictError,
  type RefundSource,
  type RefundSourceReader,
} from './refunds.js';

interface PaymentSourceRow {
  payment_id: string;
  invoice_id: string;
  amount_cents: number;
  payment_allocated_cents: number;
  status: string;
  method: string;
  stripe_payment_intent_id: string | null;
  invoice_total_cents: number;
  invoice_paid_cents: number;
  invoice_credit_cents: number;
  invoice_disputed_cents: number;
  invoice_dispute_lost_cents: number;
  refund_terms: unknown;
}

function stripeMethod(value: string): RefundSource['method'] {
  if (
    value === 'card' ||
    value === 'us_bank_account' ||
    value === 'link' ||
    value === 'apple_pay' ||
    value === 'google_pay'
  )
    return value;
  throw new RefundConflictError(
    'Original-method refunds require a Stripe payment method',
  );
}

/** Reads immutable invoice terms and the exact invoice lines funded by this payment. */
export class PostgresRefundSourceReader implements RefundSourceReader {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async load(orgId: string, paymentId: string): Promise<RefundSource | null> {
    if (orgId !== this.context.orgId)
      throw new Error('Refund source organization mismatch');
    return this.withOrg(this.context, (trx) =>
      this.loadInTransaction(trx, orgId, paymentId),
    );
  }

  async loadInTransaction(
    trx: OrgTransaction,
    orgId: string,
    paymentId: string,
  ): Promise<RefundSource | null> {
    if (orgId !== this.context.orgId)
      throw new Error('Refund source organization mismatch');
    const source = await sql<PaymentSourceRow>`
        SELECT p.id AS payment_id, pa.invoice_id, p.amount_cents,
          pa.amount_cents AS payment_allocated_cents,
          p.status, p.method, p.stripe_payment_intent_id,
          i.total_cents AS invoice_total_cents,
          i.paid_cents AS invoice_paid_cents,
          i.credit_applied_cents AS invoice_credit_cents,
          i.disputed_cents AS invoice_disputed_cents,
          i.dispute_lost_cents AS invoice_dispute_lost_cents,
          i.refund_terms
        FROM payments p JOIN payment_allocations pa
          ON pa.org_id = p.org_id AND pa.payment_id = p.id
        JOIN invoices i ON i.org_id = pa.org_id AND i.id = pa.invoice_id
        WHERE p.org_id = ${orgId}::uuid AND p.id = ${paymentId}::uuid
      `.execute(trx);
    if (source.rows.length === 0) return null;
    const row = source.rows[0];
    if (source.rows.length !== 1 || !row)
      throw new RefundConflictError(
        'Refund source payment has multiple invoice allocations',
      );
    if (
      row.amount_cents !== row.payment_allocated_cents ||
      row.invoice_paid_cents < row.amount_cents ||
      row.invoice_disputed_cents !== 0 ||
      row.invoice_dispute_lost_cents !== 0
    )
      throw new RefundConflictError(
        'Refund source payment or dispute cents do not reconcile',
      );
    if (!row.stripe_payment_intent_id)
      throw new RefundConflictError(
        'Refund source has no Stripe PaymentIntent',
      );
    if (!row.refund_terms)
      throw new RefundConflictError('Invoice has no frozen refund terms');
    const terms = refundTermsSchema.parse(row.refund_terms);
    const method = stripeMethod(row.method);
    const lines = await trx
      .selectFrom('invoice_lines')
      .select(['id', 'kind', 'amount_cents', 'refundable', 'parent_line_id'])
      .where('org_id', '=', orgId)
      .where('invoice_id', '=', row.invoice_id)
      .orderBy('id')
      .execute();
    const serviceFees = lines.filter((line) => line.kind === 'service_fee');
    if (serviceFees.length > 1)
      throw new Error('Refund source has multiple service fee lines');
    const discounts = lines.filter(
      (line) => line.kind === 'discount' || line.kind === 'aid',
    );
    if (discounts.some((line) => !line.parent_line_id))
      throw new Error('Refund source discount or aid lacks a parent line');
    const negatives = new Map<string, number>();
    for (const discount of discounts) {
      const parentId = discount.parent_line_id;
      if (
        !parentId ||
        !lines.some((line) => line.id === parentId && line.amount_cents > 0)
      )
        throw new Error('Refund source discount parent is unavailable');
      negatives.set(
        parentId,
        (negatives.get(parentId) ?? 0) + discount.amount_cents,
      );
    }
    const allocations = await sql<{
      invoice_line_id: string;
      refunded_cents: number;
    }>`
        SELECT ra.invoice_line_id,
          coalesce(sum(ra.amount_cents), 0)::bigint AS refunded_cents
        FROM refund_allocations ra JOIN refunds r
          ON r.org_id = ra.org_id AND r.id = ra.refund_id
        JOIN invoice_lines il
          ON il.org_id = ra.org_id AND il.id = ra.invoice_line_id
        WHERE ra.org_id = ${orgId}::uuid
          AND il.invoice_id = ${row.invoice_id}::uuid
          AND r.payment_id = ${paymentId}::uuid
          AND r.status IN ('pending', 'succeeded')
        GROUP BY ra.invoice_line_id
      `.execute(trx);
    const prior = new Map(
      allocations.rows.map((allocation) => [
        allocation.invoice_line_id,
        allocation.refunded_cents,
      ]),
    );
    const funded = await sql<{
      invoice_line_id: string;
      amount_cents: number;
    }>`
        SELECT invoice_line_id, amount_cents
        FROM payment_line_allocations
        WHERE org_id = ${orgId}::uuid
          AND payment_id = ${paymentId}::uuid
          AND invoice_id = ${row.invoice_id}::uuid
      `.execute(trx);
    const hasFundedLines = funded.rows.length > 0;
    const legacyFullPayment =
      !hasFundedLines &&
      row.amount_cents === row.invoice_total_cents &&
      row.invoice_paid_cents === row.amount_cents &&
      row.invoice_credit_cents === 0;
    if (!hasFundedLines && !legacyFullPayment)
      throw new RefundConflictError(
        'Payment has no immutable invoice-line allocation',
      );
    const fundedByLine = new Map(
      funded.rows.map((allocation) => [
        allocation.invoice_line_id,
        allocation.amount_cents,
      ]),
    );
    if (
      hasFundedLines &&
      (funded.rows.reduce(
        (sum, allocation) => sum + BigInt(allocation.amount_cents),
        0n,
      ) !== BigInt(row.amount_cents) ||
        fundedByLine.size !== funded.rows.length ||
        funded.rows.some(
          (allocation) =>
            !lines.some(
              (line) =>
                line.id === allocation.invoice_line_id && line.amount_cents > 0,
            ),
        ))
    )
      throw new RefundConflictError(
        'Payment line allocations do not reconcile',
      );
    const refundable: RefundableLine[] = [];
    for (const line of lines) {
      if (
        line.amount_cents <= 0 ||
        line.kind === 'service_fee' ||
        !line.refundable
      )
        continue;
      const netCents = line.amount_cents + (negatives.get(line.id) ?? 0);
      const paidCents = hasFundedLines
        ? (fundedByLine.get(line.id) ?? 0)
        : netCents;
      const previouslyRefundedCents = prior.get(line.id) ?? 0;
      if (
        paidCents < 0 ||
        paidCents > netCents ||
        previouslyRefundedCents > paidCents
      )
        throw new Error('Refundable line cents do not reconcile');
      if (paidCents > 0)
        refundable.push({ id: line.id, paidCents, previouslyRefundedCents });
    }
    const fee = serviceFees[0];
    const paidServiceFeeCents = fee?.refundable
      ? hasFundedLines
        ? (fundedByLine.get(fee.id) ?? 0)
        : fee.amount_cents
      : 0;
    const previouslyRefundedServiceFeeCents = fee
      ? (prior.get(fee.id) ?? 0)
      : 0;
    if (previouslyRefundedServiceFeeCents > paidServiceFeeCents)
      throw new Error('Refundable service fee cents do not reconcile');
    return {
      orgId,
      paymentId,
      paymentIntentId: row.stripe_payment_intent_id,
      paymentStatus:
        row.status === 'succeeded'
          ? 'succeeded'
          : row.status === 'processing'
            ? 'processing'
            : 'failed',
      method,
      lines: refundable,
      paidServiceFeeCents,
      previouslyRefundedServiceFeeCents,
      policy: terms.policy,
      approvalThresholdCents: terms.approvalThresholdCents,
      refundApplicationFee: terms.refundApplicationFee,
    };
  }
}
