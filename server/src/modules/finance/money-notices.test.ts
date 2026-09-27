import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import {
  FakeEmailSender,
  type EmailSender,
} from '../../integrations/email/sender.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import {
  enqueueFinanceNotice,
  PostgresFinanceNoticeDelivery,
} from './money-notices.js';
import { PostgresOfflinePayments } from './offline-payments.js';

let database: Kysely<DB>;
let context: OrgContext;
let firstInvoiceId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `notice-${randomUUID()}@example.invalid`,
      email_verified_at: new Date(),
      first_name: 'Payer',
      last_name: 'Notice',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `notice-${randomUUID().slice(0, 12)}`,
      name: 'Notice Club',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
});
afterAll(async () => {
  await database.destroy();
});

it('queues one notice per money event and delivers through the fake adapter', async () => {
  const key = randomUUID();
  const invoiceInput = {
    orgId: context.orgId,
    accountId: context.actor.accountId,
    source: 'staff' as const,
    creationKey: key,
    lines: [
      {
        kind: 'tuition' as const,
        description: 'Tuition',
        amountCents: 1000,
        refundable: true,
      },
    ],
  };
  const invoices = new PostgresInvoiceRepository(database, context);
  const invoice = await invoices.issue(invoiceInput);
  firstInvoiceId = invoice.id;
  expect((await invoices.issue(invoiceInput)).id).toBe(invoice.id);
  const receipt = await new PostgresOfflinePayments(database, context).record({
    orgId: context.orgId,
    invoiceId: invoice.id,
    amountCents: 1000,
    method: 'cash',
    reference: null,
    idempotencyKey: randomUUID(),
  });
  const rows = await createWithOrg(database)(context, (trx) =>
    sql<{ kind: string; source_id: string }>`
      SELECT kind, source_id FROM finance_notice_outbox
      WHERE org_id = ${context.orgId}::uuid ORDER BY kind
    `.execute(trx),
  );
  expect(rows.rows).toEqual([
    { kind: 'invoice_issued', source_id: invoice.id },
    { kind: 'payment_received', source_id: receipt.paymentId },
  ]);
  const sender = new FakeEmailSender();
  const delivery = new PostgresFinanceNoticeDelivery(
    database,
    context,
    sender,
    'http://127.0.0.1:5173',
  );
  expect(await delivery.deliverOne()).toBe('sent');
  expect(await delivery.deliverOne()).toBe('sent');
  expect(await delivery.deliverOne()).toBe('empty');
  expect(sender.messages).toHaveLength(2);
  expect(
    sender.messages.every(
      (message) =>
        message.kind === 'transactional' && Boolean(message.idempotencyKey),
    ),
  ).toBe(true);
  const state = await createWithOrg(database)(context, (trx) =>
    sql<{ status: string; sent_at: Date | null }>`
      SELECT status, sent_at FROM finance_notice_outbox
      WHERE org_id = ${context.orgId}::uuid
    `.execute(trx),
  );
  expect(state.rows.every((row) => row.status === 'sent' && row.sent_at)).toBe(
    true,
  );
});

it('refuses a finance notice addressed to another account', async () => {
  await expect(
    createWithOrg(database)(context, (trx) =>
      enqueueFinanceNotice(trx, context, {
        kind: 'invoice_issued',
        sourceId: firstInvoiceId,
        accountId: newId(),
      }),
    ),
  ).rejects.toThrow('does not own source');
});

it('retries an ambiguous delivery with the original provider key', async () => {
  await new PostgresInvoiceRepository(database, context).issue({
    orgId: context.orgId,
    accountId: context.actor.accountId,
    source: 'staff',
    creationKey: randomUUID(),
    lines: [
      {
        kind: 'tuition',
        description: 'Second invoice',
        amountCents: 200,
        refundable: true,
      },
    ],
  });
  const keys: string[] = [];
  const sender: EmailSender = {
    send(message) {
      keys.push(message.idempotencyKey ?? '');
      if (keys.length === 1)
        return Promise.reject(new Error('Ambiguous network result'));
      return Promise.resolve({ providerId: 'fake-retry' });
    },
  };
  const delivery = new PostgresFinanceNoticeDelivery(
    database,
    context,
    sender,
    'http://127.0.0.1:5173',
  );
  await expect(delivery.deliverOne()).rejects.toThrow('Ambiguous network');
  expect(await delivery.deliverOne()).toBe('sent');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});
