import { newId } from '@shared/ids';
import { allocate } from '@shared/money';
import { sql } from 'kysely';

import type { OrgTransaction } from '../../db/withOrg.js';

interface InvoiceLine {
  id: string;
  amount_cents: number;
  parent_line_id: string | null;
}

interface PriorPayment {
  payment_id: string;
  allocated_cents: number;
  line_cents: number;
}

interface PriorLine {
  invoice_line_id: string;
  amount_cents: number;
}

/** Freezes which net invoice-line cents an individual payment funds. */
export async function allocatePaymentLines(
  trx: OrgTransaction,
  input: {
    orgId: string;
    invoiceId: string;
    paymentId: string;
    amountCents: number;
  },
): Promise<void> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1)
    throw new RangeError('Payment line allocation cents must be positive');
  const invoice = await trx
    .selectFrom('invoices')
    .select(['id', 'total_cents'])
    .where('org_id', '=', input.orgId)
    .where('id', '=', input.invoiceId)
    .forUpdate()
    .executeTakeFirst();
  if (!invoice) throw new Error('Payment line invoice is unavailable');
  const existing = await sql<{
    invoice_id: string;
    invoice_line_id: string;
    amount_cents: number;
  }>`
    SELECT invoice_id, invoice_line_id, amount_cents FROM payment_line_allocations
    WHERE org_id = ${input.orgId}::uuid
      AND payment_id = ${input.paymentId}::uuid
  `.execute(trx);
  if (existing.rows.length) {
    const total = existing.rows.reduce(
      (sum, row) => sum + BigInt(row.amount_cents),
      0n,
    );
    if (
      total !== BigInt(input.amountCents) ||
      existing.rows.some((row) => row.invoice_id !== input.invoiceId)
    )
      throw new Error('Existing payment line allocation does not reconcile');
    return;
  }
  const lines = (await trx
    .selectFrom('invoice_lines')
    .select(['id', 'amount_cents', 'parent_line_id'])
    .where('org_id', '=', input.orgId)
    .where('invoice_id', '=', input.invoiceId)
    .orderBy('id')
    .execute()) as InvoiceLine[];
  const capacities = new Map<string, number>();
  for (const line of lines)
    if (line.amount_cents > 0) capacities.set(line.id, line.amount_cents);
  for (const line of lines) {
    if (line.amount_cents >= 0) continue;
    if (!line.parent_line_id || !capacities.has(line.parent_line_id))
      throw new Error('Negative invoice line lacks a funded parent');
    capacities.set(
      line.parent_line_id,
      (capacities.get(line.parent_line_id) ?? 0) + line.amount_cents,
    );
  }
  if (
    [...capacities.values()].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    throw new Error('Net invoice line cents are invalid');
  if (
    [...capacities.values()].reduce((sum, value) => sum + BigInt(value), 0n) !==
    BigInt(invoice.total_cents)
  )
    throw new Error('Net invoice lines do not reconcile with invoice total');
  const payments = await sql<PriorPayment>`
    SELECT pa.payment_id, pa.amount_cents AS allocated_cents,
      coalesce(sum(pla.amount_cents), 0)::bigint AS line_cents
    FROM payment_allocations pa JOIN payments p
      ON p.org_id = pa.org_id AND p.id = pa.payment_id
    LEFT JOIN payment_line_allocations pla
      ON pla.org_id = pa.org_id AND pla.payment_id = pa.payment_id
        AND pla.invoice_id = pa.invoice_id
    WHERE pa.org_id = ${input.orgId}::uuid
      AND pa.invoice_id = ${input.invoiceId}::uuid
      AND pa.payment_id <> ${input.paymentId}::uuid
      AND p.status IN ('requires_action', 'processing', 'succeeded')
    GROUP BY pa.payment_id, pa.amount_cents
  `.execute(trx);
  if (
    payments.rows.some(
      (payment) => payment.allocated_cents !== payment.line_cents,
    )
  )
    throw new Error('Active payment has no reconciled line allocation');
  const prior = await sql<PriorLine>`
    SELECT pla.invoice_line_id,
      sum(pla.amount_cents)::bigint AS amount_cents
    FROM payment_line_allocations pla JOIN payments p
      ON p.org_id = pla.org_id AND p.id = pla.payment_id
    WHERE pla.org_id = ${input.orgId}::uuid
      AND pla.invoice_id = ${input.invoiceId}::uuid
      AND pla.payment_id <> ${input.paymentId}::uuid
      AND p.status IN ('requires_action', 'processing', 'succeeded')
    GROUP BY pla.invoice_line_id
  `.execute(trx);
  for (const line of prior.rows) {
    const remaining = capacities.get(line.invoice_line_id);
    if (remaining === undefined || line.amount_cents > remaining)
      throw new Error('Prior payment line allocations exceed invoice cents');
    capacities.set(line.invoice_line_id, remaining - line.amount_cents);
  }
  const remaining = [...capacities.entries()];
  const available = remaining.reduce(
    (sum, [, cents]) => sum + BigInt(cents),
    0n,
  );
  if (BigInt(input.amountCents) > available)
    throw new Error('Payment exceeds unallocated invoice line cents');
  const shares = allocate(
    input.amountCents,
    remaining.map(([, cents]) => cents),
  );
  for (const [index, share] of shares.entries()) {
    if (share === 0) continue;
    const [lineId, capacity] = remaining[index] ?? [];
    if (!lineId || capacity === undefined || share > capacity)
      throw new Error('Payment line allocation exceeds remaining line');
    await sql`
      INSERT INTO payment_line_allocations
        (id, org_id, payment_id, invoice_id, invoice_line_id, amount_cents)
      VALUES (${newId()}::uuid, ${input.orgId}::uuid,
        ${input.paymentId}::uuid, ${input.invoiceId}::uuid,
        ${lineId}::uuid, ${share})
    `.execute(trx);
  }
}

/** Rejects a refund proposal that exceeds the cents this payment funded on any line. */
export async function assertPaymentFundsRefund(
  trx: OrgTransaction,
  input: {
    orgId: string;
    paymentId: string;
    invoiceId: string;
    paymentAmountCents: number;
    lines: readonly { lineId: string; amountCents: number }[];
  },
): Promise<void> {
  const funded = await sql<{ invoice_line_id: string; amount_cents: number }>`
    SELECT invoice_line_id, amount_cents FROM payment_line_allocations
    WHERE org_id = ${input.orgId}::uuid
      AND payment_id = ${input.paymentId}::uuid
      AND invoice_id = ${input.invoiceId}::uuid
  `.execute(trx);
  if (!funded.rows.length) {
    const invoice = await trx
      .selectFrom('invoices')
      .select(['total_cents', 'paid_cents', 'credit_applied_cents'])
      .where('org_id', '=', input.orgId)
      .where('id', '=', input.invoiceId)
      .executeTakeFirstOrThrow();
    if (
      invoice.total_cents !== input.paymentAmountCents ||
      invoice.paid_cents !== input.paymentAmountCents ||
      invoice.credit_applied_cents !== 0
    )
      throw new Error('Refund payment has no immutable line allocation');
    return;
  }
  const fundedTotal = funded.rows.reduce(
    (sum, line) => sum + BigInt(line.amount_cents),
    0n,
  );
  if (fundedTotal !== BigInt(input.paymentAmountCents))
    throw new Error('Payment line allocations do not reconcile for refund');
  const fundedByLine = new Map(
    funded.rows.map((line) => [line.invoice_line_id, line.amount_cents]),
  );
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.amountCents) || line.amountCents < 1)
      throw new Error('Refund line cents are invalid');
    const prior = await sql<{ total: number }>`
      SELECT coalesce(sum(ra.amount_cents), 0)::bigint AS total
      FROM refund_allocations ra JOIN refunds r
        ON r.org_id = ra.org_id AND r.id = ra.refund_id
      WHERE ra.org_id = ${input.orgId}::uuid
        AND ra.invoice_line_id = ${line.lineId}::uuid
        AND r.payment_id = ${input.paymentId}::uuid
        AND r.status IN ('pending', 'succeeded')
    `.execute(trx);
    if (
      line.amountCents + (prior.rows[0]?.total ?? 0) >
      (fundedByLine.get(line.lineId) ?? 0)
    )
      throw new Error('Refund exceeds cents funded by this payment');
  }
}
