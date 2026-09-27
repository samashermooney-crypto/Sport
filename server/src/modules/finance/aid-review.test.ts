import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresAidAwards } from './aid-awards.js';
import { PostgresAidReview } from './aid-review.js';

let database: Kysely<DB>;
let context: OrgContext;
let seasonId: string;
let aidProgramId: string;
let householdId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  seasonId = newId();
  aidProgramId = newId();
  householdId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `aid-review-${randomUUID()}@example.invalid`,
      first_name: 'Aid',
      last_name: 'Reviewer',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `aid-review-${randomUUID().slice(0, 12)}`,
      name: 'Aid Review Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('seasons')
      .values({
        id: seasonId,
        org_id: orgId,
        name: 'Season',
        starts_on: '2026-01-01',
        ends_on: '2027-12-31',
      })
      .execute();
    await trx
      .insertInto('households')
      .values({ id: householdId, org_id: orgId, name: 'Family' })
      .execute();
    await trx
      .insertInto('financial_aid_programs')
      .values({
        id: aidProgramId,
        org_id: orgId,
        name: 'Season aid',
        season_id: seasonId,
        budget_cents: 1000,
        status: 'open',
      })
      .execute();
  });
});
afterAll(async () => {
  await database.destroy();
});

describe('aid review queue', () => {
  it('pages metadata without exposing answers and fences award/decline decisions', async () => {
    const ids = [newId(), newId()];
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('aid_applications')
        .values(
          ids.map((id) => ({
            id,
            org_id: context.orgId,
            financial_aid_program_id: aidProgramId,
            household_id: householdId,
            requested_cents: 500,
            answers: sql`${JSON.stringify({ formAnswer: 'not in queue' })}::jsonb`,
            documents: sql`${JSON.stringify([{ fileId: randomUUID() }])}::jsonb`,
            status: 'submitted',
          })),
        )
        .execute(),
    );
    const review = new PostgresAidReview(database, context);
    const first = await review.queue({ seasonId, limit: 1 });
    expect(first.applications).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    expect(JSON.stringify(first)).not.toContain('formAnswer');
    expect(JSON.stringify(first)).not.toContain('fileId');
    const second = await review.queue({
      seasonId,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.applications).toHaveLength(1);
    expect(second.applications[0]?.id).not.toBe(first.applications[0]?.id);
    const reviewingId = first.applications[0]?.id;
    const declinedId = second.applications[0]?.id;
    if (!reviewingId || !declinedId) throw new Error('Queue is empty');
    const started = await review.decide(reviewingId, {
      action: 'start_review',
      expectedVersion: 1,
    });
    expect(started.status).toBe('under_review');
    await expect(
      review.decide(reviewingId, {
        action: 'decline',
        expectedVersion: 1,
        reason: 'incomplete_application',
      }),
    ).rejects.toThrow('not reviewable');
    const declined = await review.decide(declinedId, {
      action: 'decline',
      expectedVersion: 1,
      reason: 'incomplete_application',
    });
    expect(declined.status).toBe('declined');
    await expect(
      new PostgresAidAwards(database, context).award({
        orgId: context.orgId,
        applicationId: declinedId,
        expectedVersion: declined.version,
        operationKey: randomUUID(),
        decision: { kind: 'fixed', amountCents: 100 },
      }),
    ).rejects.toThrow('not awardable');
    const remaining = await review.queue({ seasonId, limit: 10 });
    expect(remaining.applications.map((item) => item.id)).toEqual([
      reviewingId,
    ]);
  });
});
