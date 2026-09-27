import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import type { OrgContext } from '../../db/withOrg.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresOfflinePayments } from './offline-payments.js';
import { PostgresPayerReceipts } from './payer-receipts.js';

let database: Kysely<DB>;
let context: OrgContext;
let outsider: OrgContext;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const otherId = newId();
  const orgId = newId();
  for (const id of [accountId, otherId]) {
    await database
      .insertInto('accounts')
      .values({
        id,
        email: `receipts-${randomUUID()}@example.invalid`,
        first_name: 'Receipt',
        last_name: 'Payer',
        date_of_birth: '1990-01-01',
      })
      .execute();
  }
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `receipts-${randomUUID().slice(0, 12)}`,
      name: 'Receipt Club',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  outsider = { orgId, actor: { accountId: otherId } };
});
afterAll(async () => {
  await database.destroy();
});

it('lists only the payer settled allocated money with download IDs', async () => {
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
    orgId: context.orgId,
    accountId: context.actor.accountId,
    source: 'staff',
    creationKey: randomUUID(),
    lines: [
      {
        kind: 'tuition',
        description: 'Tuition',
        amountCents: 1000,
        refundable: true,
      },
    ],
  });
  const payment = await new PostgresOfflinePayments(database, context).record({
    orgId: context.orgId,
    invoiceId: invoice.id,
    amountCents: 1000,
    method: 'cash',
    reference: null,
    idempotencyKey: randomUUID(),
  });
  expect(await new PostgresPayerReceipts(database, outsider).list()).toEqual({
    receipts: [],
    nextCursor: null,
  });
  expect(
    await new PostgresPayerReceipts(database, context).list(),
  ).toMatchObject({
    receipts: [
      {
        paymentId: payment.paymentId,
        amountCents: 1000,
        invoiceNumbers: [invoice.number],
      },
    ],
    nextCursor: null,
  });
});
