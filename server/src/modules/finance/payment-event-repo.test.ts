import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresPaymentEventRepository } from './payment-event-repo.js';
import { PostgresPaymentRecordStore } from './payment-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let invoiceId: string;
let checkoutId: string;
let records: PostgresPaymentRecordStore;
let events: PostgresPaymentEventRepository;
let firstPaymentId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  checkoutId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `settlement-${randomUUID()}@example.invalid`,
      first_name: 'Settlement',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `settlement-${randomUUID().slice(0, 12)}`,
      name: 'Settlement Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
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
  events = new PostgresPaymentEventRepository(database, accountId, () =>
    Temporal.Instant.from('2026-09-26T12:00:00Z'),
  );
});

afterAll(async () => {
  await database.destroy();
});

async function record(amountCents: number) {
  const paymentIntentId = `pi_${randomUUID()}`;
  await records.recordPending({
    orgId: context.orgId,
    checkoutId,
    invoiceId,
    accountId: context.actor.accountId,
    paymentIntentId,
    amountCents,
    applicationFeeCents: 10,
    idempotencyKey: randomUUID(),
  });
  return paymentIntentId;
}

function latest(id: string, amountCents: number, status: string) {
  return {
    id,
    clientSecret: null,
    status,
    amountCents,
    latestChargeId: status === 'succeeded' ? `ch_${id}` : null,
    method: 'us_bank_account' as const,
  };
}

async function state(id: string) {
  return createWithOrg(database)(context, async (trx) => ({
    payment: await trx
      .selectFrom('payments')
      .select(['status', 'method', 'succeeded_at'])
      .where('org_id', '=', context.orgId)
      .where('stripe_payment_intent_id', '=', id)
      .executeTakeFirstOrThrow(),
    invoice: await trx
      .selectFrom('invoices')
      .select(['status', 'paid_cents', 'balance_cents'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow(),
  }));
}

describe('Stripe PaymentIntent settlement', () => {
  it('does not count processing funds and applies success once', async () => {
    const id = await record(600);
    firstPaymentId = id;
    expect(
      await events.applyLatest({
        orgId: context.orgId,
        paymentIntentId: id,
        latest: latest(id, 600, 'processing'),
      }),
    ).toBe('applied');
    expect((await state(id)).invoice.paid_cents).toBe(0);
    expect(
      await events.applyLatest({
        orgId: context.orgId,
        paymentIntentId: id,
        latest: latest(id, 600, 'succeeded'),
      }),
    ).toBe('applied');
    expect(
      await events.applyLatest({
        orgId: context.orgId,
        paymentIntentId: id,
        latest: latest(id, 600, 'succeeded'),
      }),
    ).toBe('unchanged');
    const after = await state(id);
    expect(after.payment.status).toBe('succeeded');
    expect(after.payment.method).toBe('us_bank_account');
    expect(after.payment.succeeded_at).toBeTruthy();
    expect(after.invoice).toEqual({
      status: 'partially_paid',
      paid_cents: 600,
      balance_cents: 400,
    });
    await expect(
      events.applyLatest({
        orgId: context.orgId,
        paymentIntentId: id,
        latest: latest(id, 600, 'processing'),
      }),
    ).rejects.toThrow('cannot regress');
  });

  it('allows a failed intent to be retried without counting the failed attempt', async () => {
    const id = await record(400);
    expect(
      await events.applyLatest({
        orgId: context.orgId,
        paymentIntentId: id,
        latest: latest(id, 400, 'requires_payment_method'),
      }),
    ).toBe('applied');
    expect((await state(id)).invoice.paid_cents).toBe(600);
    expect(
      await events.applyLatest({
        orgId: context.orgId,
        paymentIntentId: id,
        latest: latest(id, 400, 'succeeded'),
      }),
    ).toBe('applied');
    expect((await state(id)).invoice).toEqual({
      status: 'paid',
      paid_cents: 1000,
      balance_cents: 0,
    });
  });

  it('rejects a mismatched amount, org or unknown intent without changing money', async () => {
    const known = `pi_${randomUUID()}`;
    await expect(
      events.applyLatest({
        orgId: context.orgId,
        paymentIntentId: known,
        latest: latest(known, 1, 'succeeded'),
      }),
    ).rejects.toThrow('no payment record');
    await expect(
      events.applyLatest({
        orgId: newId(),
        paymentIntentId: firstPaymentId,
        latest: latest(firstPaymentId, 600, 'succeeded'),
      }),
    ).rejects.toThrow('no payment record');
    await expect(
      events.applyLatest({
        orgId: context.orgId,
        paymentIntentId: firstPaymentId,
        latest: latest(firstPaymentId, 601, 'succeeded'),
      }),
    ).rejects.toThrow('amount differs');
    expect((await state(firstPaymentId)).invoice.paid_cents).toBe(1000);
  });
});
