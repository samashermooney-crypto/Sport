import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { decodeCursor, pageFromRows } from '../../lib/pagination.js';
import { appendAuditEvent } from '../audit/service.js';

import { MoneyDocumentUnavailableError } from './money-documents.js';

export const payerReceiptSchema = z.strictObject({
  paymentId: z.uuid(),
  amountCents: z.number().int().positive(),
  method: z.string(),
  succeededAt: z.iso.datetime(),
  receiptNumber: z.number().int().positive().nullable(),
  invoiceNumbers: z.array(z.number().int().positive()),
});
export const payerReceiptListSchema = z.strictObject({
  receipts: z.array(payerReceiptSchema),
  nextCursor: z.string().nullable(),
});

interface ReceiptRow {
  id: string;
  amount_cents: number;
  method: string;
  succeeded_at: Date;
  succeeded_at_cursor: string;
  receipt_number: number | null;
  invoice_numbers: string[];
  allocated_cents: number;
}

/** Account-scoped, microsecond-safe feed of settled payment receipts. */
export class PostgresPayerReceipts {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async list(
    cursor?: string,
  ): Promise<z.output<typeof payerReceiptListSchema>> {
    const decoded = cursor
      ? decodeCursor(cursor, 'receipt-succeeded-desc')
      : null;
    const beforeDate = decoded ? z.iso.datetime().parse(decoded.value) : null;
    const beforeId = decoded?.id ?? null;
    return this.withOrg(this.context, async (trx) => {
      const result = await sql<ReceiptRow>`
        SELECT p.id, p.amount_cents, p.method, p.succeeded_at,
          to_char(p.succeeded_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS succeeded_at_cursor,
          p.receipt_number,
          coalesce(array_agg(DISTINCT i.number ORDER BY i.number)
            FILTER (WHERE i.id IS NOT NULL), '{}'::integer[]) AS invoice_numbers,
          coalesce(sum(pa.amount_cents) FILTER
            (WHERE i.id IS NOT NULL), 0)::bigint AS allocated_cents
        FROM payments p
        LEFT JOIN payment_allocations pa ON pa.org_id = p.org_id
          AND pa.payment_id = p.id
        LEFT JOIN invoices i ON i.org_id = pa.org_id AND i.id = pa.invoice_id
          AND i.account_id = p.account_id
        WHERE p.org_id = ${this.context.orgId}::uuid
          AND p.account_id = ${this.context.actor.accountId}::uuid
          AND p.status = 'succeeded' AND p.succeeded_at IS NOT NULL
          AND (${beforeDate}::timestamptz IS NULL OR
            (p.succeeded_at, p.id) <
              (${beforeDate}::timestamptz, ${beforeId}::uuid))
        GROUP BY p.id ORDER BY p.succeeded_at DESC, p.id DESC
        LIMIT 51
      `.execute(trx);
      if (
        result.rows.some(
          (row) =>
            !Number.isSafeInteger(row.allocated_cents) ||
            row.allocated_cents !== row.amount_cents ||
            row.invoice_numbers.length === 0,
        )
      )
        throw new MoneyDocumentUnavailableError();
      await appendAuditEvent(trx, this.context, {
        action: 'finance.receipts_read',
        entityType: 'organization',
        entityId: this.context.orgId,
        changes: {},
      });
      const page = pageFromRows(result.rows, 50, (row) => ({
        sort: 'receipt-succeeded-desc',
        value: row.succeeded_at_cursor,
        id: row.id,
      }));
      return payerReceiptListSchema.parse({
        receipts: page.items.map((row) => ({
          paymentId: row.id,
          amountCents: row.amount_cents,
          method: row.method,
          succeededAt: row.succeeded_at.toISOString(),
          receiptNumber: row.receipt_number,
          invoiceNumbers: row.invoice_numbers.map((value) => Number(value)),
        })),
        nextCursor: page.nextCursor,
      });
    });
  }
}
