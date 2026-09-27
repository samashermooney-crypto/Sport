import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresRefundAttemptStore } from './refund-attempt-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let paymentId: string;
let store: PostgresRefundAttemptStore;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  paymentId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `refund-${randomUUID()}@example.invalid`,
      first_name: 'Refund',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `refund-${randomUUID().slice(0, 12)}`,
      name: 'Refund Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, (trx) =>
    trx
      .insertInto('payments')
      .values({
        id: paymentId,
        org_id: orgId,
        account_id: accountId,
        method: 'card',
        status: 'processing',
        amount_cents: 1000,
        stripe_payment_intent_id: `pi_${randomUUID()}`,
        stripe_charge_id: null,
        reference: null,
        received_by: null,
        idempotency_key: null,
        failure_code: null,
        failure_message: null,
        succeeded_at: null,
      })
      .execute(),
  );
  store = new PostgresRefundAttemptStore(database, context);
});

afterAll(async () => {
  await database.destroy();
});

function request(key = randomUUID()) {
  return {
    orgId: context.orgId,
    paymentId,
    key,
    requestHash: 'c'.repeat(64),
  };
}

const result = {
  id: 're_test_repo_1',
  status: 'pending',
  proposal: {
    lines: [{ lineId: 'line-1', amountCents: 400 }],
    serviceFeeCents: 20,
    totalCents: 420,
    refundBps: 5000,
  },
};

describe('Postgres refund attempt store', () => {
  it('atomically fences and replays a completed refund', async () => {
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
      await store.reserve({ ...input, requestHash: 'd'.repeat(64) }),
    ).toEqual({
      kind: 'conflict',
    });
    await store.beginExternal(input);
    await expect(store.fail(input)).rejects.toThrow('state changed');
    await store.complete({ ...input, result });
    expect(await store.reserve(input)).toEqual({ kind: 'replay', result });
    const separateKeys = [request(), request()];
    const outcomes = await Promise.all(
      separateKeys.map((item) => store.reserve(item)),
    );
    expect(outcomes.map((item) => item.kind).sort()).toEqual([
      'busy',
      'reserved',
    ]);
    const reservedIndex = outcomes.findIndex(
      (item) => item.kind === 'reserved',
    );
    const reserved = separateKeys[reservedIndex];
    if (!reserved) throw new Error('No reserved refund attempt');
    await store.fail(reserved);
  });

  it('retries only a pre-external failure', async () => {
    const input = request();
    await store.reserve(input);
    await store.fail(input);
    expect(await store.reserve(input)).toEqual({ kind: 'reserved' });
    await store.beginExternal(input);
    expect(await store.reserve(input)).toEqual({ kind: 'busy' });
  });
});
