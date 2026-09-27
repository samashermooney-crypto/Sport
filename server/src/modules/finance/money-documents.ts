import { inflateSync } from 'node:zlib';

import * as fontkit from '@pdf-lib/fontkit';
import { sql, type Kysely } from 'kysely';
import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import { openSansRegularDeflatedBase64 } from './open-sans-font.js';

export class MoneyDocumentNotFoundError extends Error {
  constructor() {
    super('Money document was not found');
  }
}
export class MoneyDocumentUnavailableError extends Error {
  constructor() {
    super('Money document cannot be reconciled');
  }
}
export class MoneyDocumentGlyphError extends Error {
  constructor() {
    super('Money document contains text unsupported by the PDF font');
  }
}

interface InvoiceRow {
  id: string;
  number: number;
  issued_at: Date | null;
  due_on: string | null;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  service_fee_cents: number;
  tax_cents: number;
  total_cents: number;
  paid_cents: number;
  refunded_cents: number;
  credit_applied_cents: number;
  balance_cents: number | null;
  memo: string | null;
}
interface LineRow {
  description: string;
  amount_cents: number;
}
interface ReceiptRow {
  id: string;
  amount_cents: number;
  method: string;
  succeeded_at: Date | null;
  receipt_number: number | null;
}
interface ReceiptAllocationRow {
  invoice_number: number;
  amount_cents: number;
  line_cents: number;
  service_fee_cents: number;
}

const dollars = (value: number): string => {
  if (!Number.isSafeInteger(value)) throw new MoneyDocumentUnavailableError();
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
};

async function render(title: string, sections: string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(title);
  const fontBytes = inflateSync(
    Buffer.from(openSansRegularDeflatedBase64, 'base64'),
  );
  const glyphFont = fontkit.create(fontBytes);
  document.registerFontkit(fontkit);
  const font = await document.embedFont(fontBytes, { subset: true });
  let page: PDFPage = document.addPage([612, 792]);
  let y = 744;
  const addPage = (): void => {
    page = document.addPage([612, 792]);
    y = 744;
  };
  const draw = (value: string, size = 11): void => {
    const safe = value.replaceAll(/\s+/g, ' ');
    for (const char of Array.from(safe)) {
      const point = char.codePointAt(0);
      if (point === undefined || !glyphFont.hasGlyphForCodePoint(point))
        throw new MoneyDocumentGlyphError();
    }
    const words = safe.split(/\s+/);
    let line = '';
    const flush = (): void => {
      if (!line) return;
      if (y < 48) addPage();
      page.drawText(line, {
        x: 48,
        y,
        size,
        font,
        color: rgb(0.12, 0.16, 0.22),
      });
      y -= size + 7;
      line = '';
    };
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > 515 && line) flush();
      if (font.widthOfTextAtSize(word, size) > 515)
        throw new MoneyDocumentUnavailableError();
      line = line ? `${line} ${word}` : word;
    }
    flush();
  };
  draw(title, 20);
  y -= 12;
  for (const section of sections) draw(section);
  return document.save();
}

/** Payer-owned PDF documents reconstructed from reconciled ledger rows. */
export class PostgresMoneyDocuments {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async invoice(invoiceId: string): Promise<Uint8Array> {
    const details = await this.withOrg(this.context, async (trx) => {
      const org = await trx
        .selectFrom('organizations')
        .select(['name', 'timezone'])
        .where('id', '=', this.context.orgId)
        .executeTakeFirstOrThrow();
      const invoice = await sql<InvoiceRow>`
        SELECT id, number, issued_at, due_on::text AS due_on, status, subtotal_cents,
          discount_cents, service_fee_cents, tax_cents, total_cents,
          paid_cents, refunded_cents, credit_applied_cents,
          balance_cents, memo FROM invoices
        WHERE org_id = ${this.context.orgId}::uuid
          AND account_id = ${this.context.actor.accountId}::uuid
          AND id = ${invoiceId}::uuid AND issued_at IS NOT NULL
      `.execute(trx);
      const row = invoice.rows[0];
      if (!row) throw new MoneyDocumentNotFoundError();
      const lines = await sql<LineRow>`
        SELECT description, amount_cents FROM invoice_lines
        WHERE org_id = ${this.context.orgId}::uuid
          AND invoice_id = ${invoiceId}::uuid
        ORDER BY created_at, id
      `.execute(trx);
      const total = lines.rows.reduce(
        (sum, line) => sum + line.amount_cents,
        0,
      );
      if (total !== row.total_cents || !Number.isSafeInteger(total))
        throw new MoneyDocumentUnavailableError();
      await appendAuditEvent(trx, this.context, {
        action: 'finance.invoice_pdf_read',
        entityType: 'invoice',
        entityId: invoiceId,
        changes: {},
      });
      return { org, row, lines: lines.rows };
    });
    const issuedDate = (value: Date | null): string =>
      value
        ? new Intl.DateTimeFormat('en-US', {
            timeZone: details.org.timezone,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          }).format(value)
        : 'Not set';
    const { row } = details;
    return render(`${details.org.name} invoice #${String(row.number)}`, [
      `Issued: ${issuedDate(row.issued_at)} | Due: ${row.due_on ?? 'Not set'}`,
      `Status: ${row.status}`,
      ...details.lines.map(
        (line) => `${line.description}: ${dollars(line.amount_cents)}`,
      ),
      `Subtotal: ${dollars(row.subtotal_cents)}`,
      `Discounts: ${dollars(row.discount_cents)}`,
      `Service fee: ${dollars(row.service_fee_cents)}`,
      `Tax: ${dollars(row.tax_cents)}`,
      `Invoice total: ${dollars(row.total_cents)}`,
      `Payments received: ${dollars(row.paid_cents)}`,
      `Refunded: ${dollars(row.refunded_cents)}`,
      `Credit applied: ${dollars(row.credit_applied_cents)}`,
      `Current balance: ${row.balance_cents === null ? 'Unavailable' : dollars(row.balance_cents)}`,
      ...(row.memo ? [`Memo: ${row.memo}`] : []),
    ]);
  }

  async receipt(paymentId: string): Promise<Uint8Array> {
    const details = await this.withOrg(this.context, async (trx) => {
      const org = await trx
        .selectFrom('organizations')
        .select(['name', 'timezone'])
        .where('id', '=', this.context.orgId)
        .executeTakeFirstOrThrow();
      const payment = await sql<ReceiptRow>`
        SELECT id, amount_cents, method, succeeded_at, receipt_number
        FROM payments WHERE org_id = ${this.context.orgId}::uuid
          AND account_id = ${this.context.actor.accountId}::uuid
          AND id = ${paymentId}::uuid AND status = 'succeeded'
      `.execute(trx);
      const row = payment.rows[0];
      if (!row) throw new MoneyDocumentNotFoundError();
      if (!row.succeeded_at) throw new MoneyDocumentUnavailableError();
      const allocations = await sql<ReceiptAllocationRow>`
        SELECT i.number AS invoice_number, pa.amount_cents,
          coalesce(sum(pla.amount_cents), 0)::bigint AS line_cents,
          coalesce(sum(pla.amount_cents) FILTER
            (WHERE il.kind = 'service_fee'), 0)::bigint AS service_fee_cents
        FROM payment_allocations pa
        JOIN invoices i ON i.org_id = pa.org_id AND i.id = pa.invoice_id
        LEFT JOIN payment_line_allocations pla ON pla.org_id = pa.org_id
          AND pla.payment_id = pa.payment_id AND pla.invoice_id = pa.invoice_id
        LEFT JOIN invoice_lines il ON il.org_id = pla.org_id
          AND il.id = pla.invoice_line_id
        WHERE pa.org_id = ${this.context.orgId}::uuid
          AND pa.payment_id = ${paymentId}::uuid
          AND i.account_id = ${this.context.actor.accountId}::uuid
        GROUP BY i.number, pa.id, pa.amount_cents
        ORDER BY i.number
      `.execute(trx);
      const allocated = allocations.rows.reduce(
        (sum, item) => sum + item.amount_cents,
        0,
      );
      if (
        !Number.isSafeInteger(allocated) ||
        allocated !== row.amount_cents ||
        allocations.rows.some((item) => item.line_cents !== item.amount_cents)
      )
        throw new MoneyDocumentUnavailableError();
      await appendAuditEvent(trx, this.context, {
        action: 'finance.receipt_pdf_read',
        entityType: 'payment',
        entityId: paymentId,
        changes: {},
      });
      return { org, row, allocations: allocations.rows };
    });
    const { row } = details;
    if (!row.succeeded_at) throw new MoneyDocumentUnavailableError();
    const date = new Intl.DateTimeFormat('en-US', {
      timeZone: details.org.timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(row.succeeded_at);
    const serviceFee = details.allocations.reduce(
      (sum, item) => sum + item.service_fee_cents,
      0,
    );
    return render(`${details.org.name} payment receipt`, [
      `Payment ID: ${row.id}`,
      ...(row.receipt_number ? [`Receipt #${String(row.receipt_number)}`] : []),
      `Received: ${date} (${details.org.timezone})`,
      `Method: ${row.method}`,
      ...details.allocations.map(
        (item) =>
          `Invoice #${String(item.invoice_number)}: ${dollars(item.amount_cents)}`,
      ),
      `Included service fee: ${dollars(serviceFee)}`,
      `Total received: ${dollars(row.amount_cents)}`,
    ]);
  }
}
