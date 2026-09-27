import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import type { OrgContext } from '../../db/withOrg.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresMoneyDocuments } from './money-documents.js';
import { PostgresOfflinePayments } from './offline-payments.js';

let database: Kysely<DB>;
let context: OrgContext;
let outsider: OrgContext;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const outsiderId = newId();
  const orgId = newId();
  for (const id of [accountId, outsiderId]) {
    await database
      .insertInto('accounts')
      .values({
        id,
        email: `pdf-${randomUUID()}@example.invalid`,
        first_name: 'Payer',
        last_name: 'Test',
        date_of_birth: '1990-01-01',
      })
      .execute();
  }
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `pdf-${randomUUID().slice(0, 12)}`,
      name: 'Club Atlético',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  outsider = { orgId, actor: { accountId: outsiderId } };
});
afterAll(async () => {
  await database.destroy();
});

describe('payer money PDFs', () => {
  it('renders reconciled invoice and receipt bytes and denies another account', async () => {
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'staff',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'tuition',
          description: 'Matrícula — fútbol',
          amountCents: 950,
          refundable: true,
        },
        {
          kind: 'service_fee',
          description: 'Service fee',
          amountCents: 50,
          refundable: true,
        },
      ],
    });
    const receipt = await new PostgresOfflinePayments(database, context).record(
      {
        orgId: context.orgId,
        invoiceId: invoice.id,
        amountCents: 1000,
        method: 'cash',
        reference: null,
        idempotencyKey: randomUUID(),
      },
    );
    const documents = new PostgresMoneyDocuments(database, context);
    const invoicePdf = await documents.invoice(invoice.id);
    const receiptPdf = await documents.receipt(receipt.paymentId);
    expect(Buffer.from(invoicePdf.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(Buffer.from(receiptPdf.subarray(0, 5)).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(invoicePdf)).getPageCount()).toBe(1);
    expect((await PDFDocument.load(receiptPdf)).getPageCount()).toBe(1);
    const other = new PostgresMoneyDocuments(database, outsider);
    await expect(other.invoice(invoice.id)).rejects.toThrow('not found');
    await expect(other.receipt(receipt.paymentId)).rejects.toThrow('not found');
  });
});
