import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresCheckoutHoldRepository } from './capacity-repo.js';
import type { SubjectQuantity } from './service.js';

let database: Kysely<DB>;
let context: OrgContext;
let repo: PostgresCheckoutHoldRepository;
let subjects: SubjectQuantity[];
let firstCheckout: string;
let secondCheckout: string;
const now = Temporal.Instant.from('2026-09-26T12:00:00Z');
const expiry = '2026-09-26T12:20:00Z';

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  firstCheckout = newId();
  secondCheckout = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `capacity-${randomUUID()}@example.invalid`,
      first_name: 'Capacity',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `capacity-${randomUUID().slice(0, 12)}`,
      name: 'Capacity Test Organization',
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
    for (const subject of subjects) {
      await trx
        .insertInto('capacity_counters')
        .values({
          id: newId(),
          org_id: orgId,
          subject_type: subject.subject,
          subject_id: subject.id,
          capacity: 1,
        })
        .execute();
    }
    for (const checkoutId of [firstCheckout, secondCheckout]) {
      await trx
        .insertInto('checkouts')
        .values({
          id: checkoutId,
          org_id: orgId,
          account_id: accountId,
          status: 'awaiting_payment',
          expires_at: new Date(expiry),
          pricing_snapshot: { totalCents: 1000 },
        })
        .execute();
    }
  });
  repo = new PostgresCheckoutHoldRepository(database, context, () => now);
});

afterAll(async () => {
  await database.destroy();
});

function request(checkoutId: string, key = randomUUID()) {
  return {
    orgId: context.orgId,
    checkoutId,
    subjects,
    expiresAt: expiry,
    idempotencyKey: key,
  };
}

async function counterState() {
  return createWithOrg(database)(context, (trx) =>
    trx
      .selectFrom('capacity_counters')
      .select(['held', 'confirmed'])
      .where('org_id', '=', context.orgId)
      .execute(),
  );
}

describe('transactional checkout capacity', () => {
  it('reserves all counter levels once and refuses a competing checkout', async () => {
    const first = request(firstCheckout);
    expect(await repo.reserve(first)).toBe('reserved');
    expect(await repo.reserve(first)).toBe('already_reserved');
    await expect(
      repo.reserve({ ...first, idempotencyKey: randomUUID() }),
    ).rejects.toThrow('conflicts');
    expect(await repo.reserve(request(secondCheckout))).toBe('full');
    expect(await counterState()).toEqual([
      { held: 1, confirmed: 0 },
      { held: 1, confirmed: 0 },
      { held: 1, confirmed: 0 },
    ]);
  });

  it('confirms once, and release cannot decrement converted seats', async () => {
    expect(
      await repo.confirm({
        orgId: context.orgId,
        checkoutId: firstCheckout,
        honorProcessingHold: false,
      }),
    ).toBe('confirmed');
    expect(
      await repo.confirm({
        orgId: context.orgId,
        checkoutId: firstCheckout,
        honorProcessingHold: false,
      }),
    ).toBe('already_confirmed');
    await repo.release({ orgId: context.orgId, checkoutId: firstCheckout });
    expect(await counterState()).toEqual([
      { held: 0, confirmed: 1 },
      { held: 0, confirmed: 1 },
      { held: 0, confirmed: 1 },
    ]);
  });
});
