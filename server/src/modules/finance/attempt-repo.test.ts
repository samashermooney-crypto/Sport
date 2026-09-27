import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import type { OrgContext } from '../../db/withOrg.js';
import { createWithOrg } from '../../db/withOrg.js';

import { PostgresPaymentAttemptStore } from './attempt-repo.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresPaymentRecordStore } from './payment-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let checkoutId: string;
let store: PostgresPaymentAttemptStore;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  checkoutId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `attempt-${randomUUID()}@example.invalid`,
      first_name: 'Attempt',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `attempt-${randomUUID().slice(0, 12)}`,
      name: 'Attempt Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, (trx) =>
    trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: orgId,
        account_id: accountId,
        expires_at: new Date('2027-01-01T00:00:00Z'),
      })
      .execute(),
  );
  store = new PostgresPaymentAttemptStore(database, context);
});

afterAll(async () => {
  await database.destroy();
});

function request(key = randomUUID()) {
  return {
    orgId: context.orgId,
    checkoutId,
    key,
    requestHash: 'a'.repeat(64),
  };
}

const result = {
  id: 'pi_test_repo_1',
  clientSecret: 'pi_test_secret',
  status: 'requires_payment_method',
  quote: {
    baseCents: 1000,
    serviceFeeCents: 50,
    taxCents: 0,
    amountCents: 1050,
    applicationFeeCents: 15,
  },
};

describe('Postgres PaymentIntent attempt store', () => {
  it('atomically reserves, fences external work and replays stored result', async () => {
    const input = request();
    const claims = await Promise.all([
      store.reserve(input),
      store.reserve(input),
    ]);
    expect(claims.map((claim) => claim.kind).sort()).toEqual([
      'busy',
      'reserved',
    ]);
    expect(
      await store.reserve({ ...input, requestHash: 'b'.repeat(64) }),
    ).toEqual({
      kind: 'conflict',
    });
    await store.beginExternal(input);
    await expect(store.fail(input)).rejects.toThrow('state changed');
    await store.complete({ ...input, result });
    expect(await store.reserve(input)).toEqual({ kind: 'replay', result });
  });

  it('reuses a key only after a pre-external failure', async () => {
    const input = request();
    expect(await store.reserve(input)).toEqual({ kind: 'reserved' });
    await store.fail(input);
    expect(await store.reserve(input)).toEqual({ kind: 'reserved' });
    await store.beginExternal(input);
    expect(await store.reserve(input)).toEqual({ kind: 'busy' });
    await expect(store.beginExternal(input)).rejects.toThrow('state changed');
  });

  it('rejects a foreign organization before querying', async () => {
    await expect(
      store.reserve({ ...request(), orgId: newId() }),
    ).rejects.toThrow('organization mismatch');
  });

  it('fences a second key until the first checkout payment fails', async () => {
    const competingCheckoutId = newId();
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('checkouts')
        .values({
          id: competingCheckoutId,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          status: 'awaiting_payment',
          expires_at: new Date('2027-01-01T00:00:00Z'),
          pricing_snapshot: { totalCents: 1000 },
        })
        .execute(),
    );
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
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
    const first = { ...request(), checkoutId: competingCheckoutId };
    const second = { ...request(), checkoutId: competingCheckoutId };
    const concurrent = await Promise.all([
      store.reserve(first),
      store.reserve(second),
    ]);
    expect(concurrent.map((claim) => claim.kind).sort()).toEqual([
      'busy',
      'reserved',
    ]);
    const winner = concurrent[0].kind === 'reserved' ? first : second;
    const loser = winner === first ? second : first;
    await store.beginExternal(winner);
    expect(await store.reserve(loser)).toEqual({ kind: 'busy' });
    const paymentIntentId = `pi_${randomUUID()}`;
    await new PostgresPaymentRecordStore(database, context).recordPending({
      orgId: context.orgId,
      checkoutId: competingCheckoutId,
      invoiceId: invoice.id,
      accountId: context.actor.accountId,
      paymentIntentId,
      amountCents: 1000,
      applicationFeeCents: 10,
      idempotencyKey: winner.key,
    });
    await store.complete({ ...winner, result });
    expect(await store.reserve(loser)).toEqual({ kind: 'busy' });
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('payments')
        .set({ status: 'failed' })
        .where('org_id', '=', context.orgId)
        .where('stripe_payment_intent_id', '=', paymentIntentId)
        .execute(),
    );
    expect(await store.reserve(loser)).toEqual({ kind: 'reserved' });
  });
});
