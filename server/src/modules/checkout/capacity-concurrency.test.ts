import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg } from '../../db/withOrg.js';

import { PostgresCheckoutHoldRepository } from './capacity-repo.js';

const now = Temporal.Instant.from('2026-09-27T12:00:00Z');
const expiry = '2026-09-27T12:20:00Z';
let database: Kysely<DB>;
const accountId = newId();
const orgId = newId();
const context = { orgId, actor: { accountId } };
const subjectId = newId();
const checkouts = Array.from({ length: 300 }, () => newId());

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `capacity-load-${randomUUID()}@example.invalid`,
      first_name: 'Capacity',
      last_name: 'Load',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `capacity-load-${randomUUID().slice(0, 12)}`,
      name: 'Capacity Load',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('capacity_counters')
      .values({
        id: newId(),
        org_id: orgId,
        subject_type: 'offering',
        subject_id: subjectId,
        capacity: 100,
      })
      .execute();
    await trx
      .insertInto('checkouts')
      .values(
        checkouts.map((id) => ({
          id,
          org_id: orgId,
          account_id: accountId,
          status: 'awaiting_payment' as const,
          expires_at: new Date(expiry),
          pricing_snapshot: { totalCents: 0 },
        })),
      )
      .execute();
  });
});

afterAll(async () => {
  await database.destroy();
});

describe('300 simultaneous capacity requests', () => {
  it('confirms exactly 100 seats and rejects 200 without oversell', async () => {
    const repo = new PostgresCheckoutHoldRepository(
      database,
      context,
      () => now,
    );
    const results = await Promise.all(
      checkouts.map((checkoutId) =>
        repo.reserve({
          orgId,
          checkoutId,
          subjects: [{ subject: 'offering', id: subjectId, quantity: 1 }],
          expiresAt: expiry,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    const winners = checkouts.filter(
      (_id, index) => results[index] === 'reserved',
    );
    expect(winners).toHaveLength(100);
    expect(results.filter((result) => result === 'full')).toHaveLength(200);
    const confirmations = await Promise.all(
      winners.map((checkoutId) =>
        repo.confirm({ orgId, checkoutId, honorProcessingHold: false }),
      ),
    );
    expect(confirmations.every((result) => result === 'confirmed')).toBe(true);
    const counters = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('capacity_counters')
        .select(['held', 'confirmed'])
        .where('org_id', '=', orgId)
        .where('subject_id', '=', subjectId)
        .executeTakeFirstOrThrow(),
    );
    expect(counters).toEqual({ held: 0, confirmed: 100 });
  }, 60_000);

  it('releases an expired hold and admits the next checkout', async () => {
    const expiringSubjectId = newId();
    const firstCheckoutId = newId();
    const nextCheckoutId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('capacity_counters')
        .values({
          id: newId(),
          org_id: orgId,
          subject_type: 'offering',
          subject_id: expiringSubjectId,
          capacity: 1,
        })
        .execute();
      await trx
        .insertInto('checkouts')
        .values(
          [firstCheckoutId, nextCheckoutId].map((id) => ({
            id,
            org_id: orgId,
            account_id: accountId,
            status: 'awaiting_payment' as const,
            expires_at: new Date(expiry),
            pricing_snapshot: { totalCents: 0 },
          })),
        )
        .execute();
    });
    const repo = new PostgresCheckoutHoldRepository(
      database,
      context,
      () => now,
    );
    const subjects = [
      { subject: 'offering' as const, id: expiringSubjectId, quantity: 1 },
    ];
    expect(
      await repo.reserve({
        orgId,
        checkoutId: firstCheckoutId,
        subjects,
        expiresAt: expiry,
        idempotencyKey: randomUUID(),
      }),
    ).toBe('reserved');
    expect(
      await repo.reserve({
        orgId,
        checkoutId: nextCheckoutId,
        subjects,
        expiresAt: expiry,
        idempotencyKey: randomUUID(),
      }),
    ).toBe('full');
    const afterExpiry = Temporal.Instant.from('2026-09-27T12:21:00Z');
    const expiryRepo = new PostgresCheckoutHoldRepository(
      database,
      context,
      () => afterExpiry,
    );
    expect(
      await expiryRepo.confirm({
        orgId,
        checkoutId: firstCheckoutId,
        honorProcessingHold: false,
      }),
    ).toBe('expired');
    await expiryRepo.release({ orgId, checkoutId: firstCheckoutId });
    const newExpiry = '2026-09-27T12:41:00Z';
    expect(
      await expiryRepo.reserve({
        orgId,
        checkoutId: nextCheckoutId,
        subjects,
        expiresAt: newExpiry,
        idempotencyKey: randomUUID(),
      }),
    ).toBe('reserved');
    const counters = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('capacity_counters')
        .select(['held', 'confirmed'])
        .where('org_id', '=', orgId)
        .where('subject_id', '=', expiringSubjectId)
        .executeTakeFirstOrThrow(),
    );
    expect(counters).toEqual({ held: 1, confirmed: 0 });
  });
});
