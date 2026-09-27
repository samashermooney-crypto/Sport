import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from './kysely';
import type { DB } from './types';
import { createWithOrg } from './withOrg';

const orgId = randomUUID();
const accountId = randomUUID();
const invoiceId = randomUUID();
const lineId = randomUUID();
const paymentId = randomUUID();
const refundId = randomUUID();
const context = { orgId, actor: { accountId } };
let database: Kysely<DB>;
let withOrg: ReturnType<typeof createWithOrg>;

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO organizations (id, slug, name, kind, timezone)
      VALUES ($1, $2, 'Finance Test', 'club', 'America/Chicago')`,
      [orgId, `finance-${orgId.slice(0, 8)}`],
    );
    await admin.query(
      `INSERT INTO accounts (id, email, first_name, last_name, date_of_birth)
      VALUES ($1, $2, 'Finance', 'Tester', '1990-01-01')`,
      [accountId, `finance-${accountId}@example.invalid`],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => {
  await database.destroy();
});

describe('deferred money reconciliation', () => {
  it('rejects an open invoice whose header differs from its lines', async () => {
    await expect(
      withOrg(context, (trx) =>
        trx
          .insertInto('invoices')
          .values({
            id: randomUUID(),
            org_id: orgId,
            number: 90,
            account_id: accountId,
            source: 'staff',
            status: 'open',
            subtotal_cents: 100,
            total_cents: 100,
          })
          .execute(),
      ),
    ).rejects.toThrow(/line total/);
  });

  it('accepts atomic invoice, payment and refund allocations', async () => {
    await withOrg(context, async (trx) => {
      await trx
        .insertInto('invoices')
        .values({
          id: invoiceId,
          org_id: orgId,
          number: 91,
          account_id: accountId,
          source: 'staff',
          status: 'draft',
        })
        .execute();
      await trx
        .insertInto('invoice_lines')
        .values({
          id: lineId,
          org_id: orgId,
          invoice_id: invoiceId,
          kind: 'registration',
          description: 'Season fee',
          unit_amount_cents: 100,
          amount_cents: 100,
        })
        .execute();
      await trx
        .updateTable('invoices')
        .set({
          status: 'open',
          subtotal_cents: 100,
          total_cents: 100,
        })
        .where('id', '=', invoiceId)
        .execute();
    });

    await expect(
      withOrg(context, (trx) =>
        trx
          .insertInto('payments')
          .values({
            id: randomUUID(),
            org_id: orgId,
            account_id: accountId,
            method: 'cash',
            status: 'succeeded',
            amount_cents: 100,
          })
          .execute(),
      ),
    ).rejects.toThrow(/payment allocations/);

    await withOrg(context, async (trx) => {
      await trx
        .insertInto('payments')
        .values({
          id: paymentId,
          org_id: orgId,
          account_id: accountId,
          method: 'cash',
          status: 'succeeded',
          amount_cents: 100,
        })
        .execute();
      await trx
        .insertInto('payment_allocations')
        .values({
          id: randomUUID(),
          org_id: orgId,
          payment_id: paymentId,
          invoice_id: invoiceId,
          amount_cents: 100,
        })
        .execute();
      await trx
        .updateTable('invoices')
        .set({ paid_cents: 100 })
        .where('id', '=', invoiceId)
        .execute();
    });

    await withOrg(context, async (trx) => {
      await trx
        .insertInto('refunds')
        .values({
          id: refundId,
          org_id: orgId,
          payment_id: paymentId,
          amount_cents: 40,
          reason: 'requested_by_customer',
          status: 'succeeded',
        })
        .execute();
      await trx
        .insertInto('refund_allocations')
        .values({
          id: randomUUID(),
          org_id: orgId,
          refund_id: refundId,
          invoice_line_id: lineId,
          amount_cents: 40,
        })
        .execute();
      await trx
        .updateTable('invoices')
        .set({ refunded_cents: 40 })
        .where('id', '=', invoiceId)
        .execute();
    });
    const invoice = await withOrg(context, (trx) =>
      trx
        .selectFrom('invoices')
        .select(['paid_cents', 'refunded_cents', 'balance_cents'])
        .where('id', '=', invoiceId)
        .executeTakeFirstOrThrow(),
    );
    expect(invoice).toEqual({
      paid_cents: 100,
      refunded_cents: 40,
      balance_cents: 40,
    });
  });
});
