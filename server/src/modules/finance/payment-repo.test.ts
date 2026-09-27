import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresPaymentRecordStore } from './payment-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let invoiceId: string;
let checkoutId: string;
let records: PostgresPaymentRecordStore;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  checkoutId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `payment-${randomUUID()}@example.invalid`,
      first_name: 'Payment',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `payment-${randomUUID().slice(0, 12)}`,
      name: 'Payment Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  const invoices = new PostgresInvoiceRepository(database, context);
  const invoice = await invoices.issue({
    orgId,
    accountId,
    source: 'checkout',
    creationKey: randomUUID(),
    lines: [
      {
        kind: 'registration',
        description: 'Registration',
        amountCents: 1000,
        refundable: true,
      },
    ],
  });
  invoiceId = invoice.id;
  await createWithOrg(database)(context, (trx) =>
    trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: orgId,
        account_id: accountId,
        status: 'awaiting_payment',
        expires_at: new Date('2027-01-01T00:00:00Z'),
        pricing_snapshot: { totalCents: 1000 },
      })
      .execute(),
  );
  records = new PostgresPaymentRecordStore(database, context);
});

afterAll(async () => {
  await database.destroy();
});

function pending(amountCents = 500) {
  return {
    orgId: context.orgId,
    checkoutId,
    invoiceId,
    accountId: context.actor.accountId,
    paymentIntentId: `pi_${randomUUID()}`,
    amountCents,
    applicationFeeCents: 10,
    idempotencyKey: randomUUID(),
  };
}

describe('pending checkout payment records', () => {
  it('atomically allocates a pending intent and replays it without duplication', async () => {
    const input = pending();
    await records.recordPending(input);
    await records.recordPending(input);
    const state = await createWithOrg(database)(context, async (trx) => ({
      payments: await trx
        .selectFrom('payments')
        .select(['status', 'method', 'amount_cents'])
        .where('stripe_payment_intent_id', '=', input.paymentIntentId)
        .execute(),
      allocations: await trx
        .selectFrom('payment_allocations')
        .select(['invoice_id', 'amount_cents'])
        .where('invoice_id', '=', invoiceId)
        .execute(),
    }));
    expect(state.payments).toEqual([
      { status: 'requires_action', method: 'unknown', amount_cents: 500 },
    ]);
    expect(state.allocations).toEqual([
      { invoice_id: invoiceId, amount_cents: 500 },
    ]);
  });

  it('rejects another pending intent above the invoice balance', async () => {
    await expect(records.recordPending(pending(600))).rejects.toThrow(
      'exceed invoice balance',
    );
    await expect(
      records.recordPending({ ...pending(500), orgId: newId() }),
    ).rejects.toThrow('organization mismatch');
  });
});
