import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

export interface PayoutReconciliationRow {
  transactionId: string;
  type: string;
  amountCents: number;
  feeCents: number;
  netCents: number;
  sourceId: string | null;
  paymentId: string | null;
  invoiceNumbers: number[];
}

export interface PayoutReconciliation {
  payoutId: string;
  status: string;
  arrivalDate: string | null;
  amountCents: number;
  transactionNetCents: number;
  differenceCents: number;
  complete: boolean;
  unlinkedSourceCount: number;
  rows: PayoutReconciliationRow[];
}

const payoutReconciliationRowSchema = z.strictObject({
  transactionId: z.string().min(1),
  type: z.string().min(1),
  amountCents: z.number().int(),
  feeCents: z.number().int(),
  netCents: z.number().int(),
  sourceId: z.string().nullable(),
  paymentId: z.uuid().nullable(),
  invoiceNumbers: z.array(z.number().int().positive()),
});

export const payoutReconciliationSchema = z.strictObject({
  payoutId: z.string().regex(/^po_[A-Za-z0-9_]+$/),
  status: z.string().min(1),
  arrivalDate: z.iso.date().nullable(),
  amountCents: z.number().int(),
  transactionNetCents: z.number().int(),
  differenceCents: z.number().int(),
  complete: z.boolean(),
  unlinkedSourceCount: z.number().int().nonnegative(),
  rows: z.array(payoutReconciliationRowSchema),
});

export class PayoutReconciliationNotFoundError extends Error {}

function csvCell(value: string | number | null): string {
  const raw = value === null ? '' : String(value);
  const text =
    typeof value === 'string' && /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function payoutReconciliationCsv(report: PayoutReconciliation): string {
  const headers = [
    'Payout ID',
    'Payout Status',
    'Arrival Date',
    'Transaction ID',
    'Type',
    'Amount Cents',
    'Fee Cents',
    'Net Cents',
    'Source ID',
    'Payment ID',
    'Invoice Numbers',
  ];
  const lines = report.rows.map((row) =>
    [
      report.payoutId,
      report.status,
      report.arrivalDate,
      row.transactionId,
      row.type,
      row.amountCents,
      row.feeCents,
      row.netCents,
      row.sourceId,
      row.paymentId,
      row.invoiceNumbers.join(';'),
    ]
      .map(csvCell)
      .join(','),
  );
  return [headers.join(','), ...lines].join('\r\n') + '\r\n';
}

/** A read-only payout → Stripe movement → payment/invoice trace. */
export class PostgresPayoutReconciliation {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async read(payoutId: string): Promise<PayoutReconciliation> {
    return this.withOrg(this.context, async (trx) => {
      const payout = await trx
        .selectFrom('payouts')
        .select([
          'stripe_payout_id',
          'status',
          'arrival_date',
          'amount_cents',
          'balance_transaction_ids',
        ])
        .where('org_id', '=', this.context.orgId)
        .where('stripe_payout_id', '=', payoutId)
        .executeTakeFirst();
      if (!payout)
        throw new PayoutReconciliationNotFoundError('Payout was not found');
      const transactions = await trx
        .selectFrom('balance_transactions')
        .select([
          'stripe_balance_transaction_id',
          'type',
          'amount_cents',
          'fee_cents',
          'net_cents',
          'source_id',
        ])
        .where('org_id', '=', this.context.orgId)
        .where('stripe_payout_id', '=', payoutId)
        .orderBy('stripe_balance_transaction_id')
        .execute();
      const rows: PayoutReconciliationRow[] = [];
      for (const transaction of transactions) {
        const sourceId = transaction.source_id;
        let paymentId: string | null = null;
        if (sourceId?.startsWith('ch_')) {
          const payment = await trx
            .selectFrom('payments')
            .select('id')
            .where('org_id', '=', this.context.orgId)
            .where('stripe_charge_id', '=', sourceId)
            .executeTakeFirst();
          paymentId = payment?.id ?? null;
        } else if (sourceId?.startsWith('re_')) {
          const refund = await trx
            .selectFrom('refunds')
            .select('payment_id')
            .where('org_id', '=', this.context.orgId)
            .where('stripe_refund_id', '=', sourceId)
            .executeTakeFirst();
          paymentId = refund?.payment_id ?? null;
        } else if (sourceId?.startsWith('dp_')) {
          const dispute = await trx
            .selectFrom('disputes')
            .select('payment_id')
            .where('org_id', '=', this.context.orgId)
            .where('stripe_dispute_id', '=', sourceId)
            .executeTakeFirst();
          paymentId = dispute?.payment_id ?? null;
        }
        const allocations = paymentId
          ? await trx
              .selectFrom('payment_allocations as pa')
              .innerJoin('invoices as i', (join) =>
                join
                  .onRef('i.org_id', '=', 'pa.org_id')
                  .onRef('i.id', '=', 'pa.invoice_id'),
              )
              .select('i.number')
              .where('pa.org_id', '=', this.context.orgId)
              .where('pa.payment_id', '=', paymentId)
              .orderBy('i.number')
              .execute()
          : [];
        rows.push({
          transactionId: transaction.stripe_balance_transaction_id,
          type: transaction.type,
          amountCents: transaction.amount_cents,
          feeCents: transaction.fee_cents,
          netCents: transaction.net_cents,
          sourceId,
          paymentId,
          invoiceNumbers: allocations.map((item) => item.number),
        });
      }
      const transactionNetCents = rows.reduce(
        (sum, row) => sum + row.netCents,
        0,
      );
      if (!Number.isSafeInteger(transactionNetCents))
        throw new Error('Payout transaction sum exceeds safe integer cents');
      const storedIds = [...payout.balance_transaction_ids].sort();
      const actualIds = rows.map((row) => row.transactionId).sort();
      return {
        payoutId,
        status: payout.status,
        arrivalDate: payout.arrival_date
          ? new Date(payout.arrival_date).toISOString().slice(0, 10)
          : null,
        amountCents: payout.amount_cents,
        transactionNetCents,
        differenceCents: payout.amount_cents - transactionNetCents,
        complete:
          JSON.stringify(storedIds) === JSON.stringify(actualIds) &&
          payout.amount_cents === transactionNetCents,
        unlinkedSourceCount: rows.filter(
          (row) => row.sourceId && !row.paymentId,
        ).length,
        rows,
      };
    });
  }
}
