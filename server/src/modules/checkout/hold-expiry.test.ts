import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresCheckoutHoldRepository } from './capacity-repo.js';
import { releaseExpiredHolds } from './hold-expiry.js';
import type { SubjectQuantity } from './service.js';

let database: Kysely<DB>;
let context: OrgContext;
let subjects: SubjectQuantity[];
const [abandoned, paying, waiting] = [newId(), newId(), newId()];
const reservedAt = Temporal.Instant.from('2026-09-26T12:00:00Z');
const expiry = '2026-09-26T12:20:00Z';

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `hold-expiry-${randomUUID()}@example.invalid`,
      first_name: 'Hold',
      last_name: 'Expiry',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `hold-expiry-${randomUUID().slice(0, 12)}`,
      name: 'Hold Expiry Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  subjects = [
    { subject: 'program', id: newId(), quantity: 1 },
    { subject: 'division', id: newId(), quantity: 1 },
    { subject: 'offering', id: newId(), quantity: 1 },
  ];
  await createWithOrg(database)(context, async (trx) => {
    for (const subject of subjects)
      await trx
        .insertInto('capacity_counters')
        .values({
          id: newId(),
          org_id: orgId,
          subject_type: subject.subject,
          subject_id: subject.id,
          capacity: 2,
        })
        .execute();
    await trx
      .insertInto('checkouts')
      .values([
        {
          id: abandoned,
          org_id: orgId,
          account_id: accountId,
          status: 'open',
          expires_at: new Date(expiry),
        },
        {
          id: paying,
          org_id: orgId,
          account_id: accountId,
          status: 'awaiting_payment',
          expires_at: new Date(expiry),
          pricing_snapshot: { totalCents: 1000 },
        },
        {
          id: waiting,
          org_id: orgId,
          account_id: accountId,
          status: 'open',
          expires_at: new Date(expiry),
        },
      ])
      .execute();
  });
  const repo = new PostgresCheckoutHoldRepository(
    database,
    context,
    () => reservedAt,
  );
  for (const checkoutId of [abandoned, paying])
    expect(
      await repo.reserve({
        orgId: context.orgId,
        checkoutId,
        subjects,
        expiresAt: expiry,
        idempotencyKey: randomUUID(),
      }),
    ).toBe('reserved');
});

afterAll(async () => {
  await database.destroy();
});

async function state() {
  return createWithOrg(database)(context, async (trx) => ({
    counters: await trx
      .selectFrom('capacity_counters')
      .select(['held', 'confirmed'])
      .where('org_id', '=', context.orgId)
      .execute(),
    checkouts: await trx
      .selectFrom('checkouts')
      .select(['id', 'status'])
      .where('org_id', '=', context.orgId)
      .orderBy('id')
      .execute(),
  }));
}

describe('expired checkout holds', () => {
  it('keeps unexpired holds, then frees abandoned places for the next family', async () => {
    expect(
      await releaseExpiredHolds(
        database,
        context.orgId,
        new Date('2026-09-26T12:19:59Z'),
      ),
    ).toBe(0);
    expect((await state()).counters).toEqual(
      subjects.map(() => ({ held: 2, confirmed: 0 })),
    );

    const afterExpiry = new Date('2026-09-26T12:21:00Z');
    expect(
      await releaseExpiredHolds(database, context.orgId, afterExpiry),
    ).toBe(3);
    const released = await state();
    // The checkout awaiting payment keeps its processing hold.
    expect(released.counters).toEqual(
      subjects.map(() => ({ held: 1, confirmed: 0 })),
    );
    expect(released.checkouts).toEqual(
      [
        { id: abandoned, status: 'expired' },
        { id: paying, status: 'awaiting_payment' },
        { id: waiting, status: 'open' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(
      await releaseExpiredHolds(database, context.orgId, afterExpiry),
    ).toBe(0);

    const repo = new PostgresCheckoutHoldRepository(database, context, () =>
      Temporal.Instant.from('2026-09-26T12:22:00Z'),
    );
    expect(
      await repo.reserve({
        orgId: context.orgId,
        checkoutId: waiting,
        subjects,
        expiresAt: '2026-09-26T12:42:00Z',
        idempotencyKey: randomUUID(),
      }),
    ).toBe('reserved');
  });
});
