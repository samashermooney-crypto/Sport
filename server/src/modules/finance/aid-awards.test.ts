import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresAidAwards } from './aid-awards.js';

let database: Kysely<DB>;
let context: OrgContext;
let seasonId: string;
let programId: string;
let householdId: string;
let aidProgramId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  seasonId = newId();
  const sportId = newId();
  programId = newId();
  householdId = newId();
  aidProgramId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `aid-${randomUUID()}@example.invalid`,
      first_name: 'Aid',
      last_name: 'Reviewer',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `aid-${randomUUID().slice(0, 12)}`,
      name: 'Aid Budget Test',
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
      .insertInto('sport_profiles')
      .values({
        id: sportId,
        org_id: orgId,
        name: 'Sport',
        profile: {},
      })
      .execute();
    await trx
      .insertInto('programs')
      .values({
        id: programId,
        org_id: orgId,
        season_id: seasonId,
        sport_profile_id: sportId,
        mode: 'league',
        name: 'League',
        slug: `aid-${randomUUID().slice(0, 12)}`,
        starts_on: '2026-01-01',
        ends_on: '2027-12-31',
      })
      .execute();
    await trx
      .insertInto('households')
      .values({
        id: householdId,
        org_id: orgId,
        name: 'Family',
      })
      .execute();
    await trx
      .insertInto('financial_aid_programs')
      .values({
        id: aidProgramId,
        org_id: orgId,
        name: 'Season aid',
        season_id: seasonId,
        budget_cents: 700,
        status: 'open',
      })
      .execute();
  });
});
afterAll(async () => {
  await database.destroy();
});

describe('aid award budget', () => {
  it('awards only one of two concurrent applications for the final budget', async () => {
    const applicationIds = [newId(), newId()];
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('aid_applications')
        .values(
          applicationIds.map((id) => ({
            id,
            org_id: context.orgId,
            financial_aid_program_id: aidProgramId,
            household_id: householdId,
            program_ids: [programId],
            requested_cents: 700,
            status: 'under_review',
          })),
        )
        .execute(),
    );
    const awards = new PostgresAidAwards(database, context);
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(
      applicationIds.map((id, index) =>
        awards.award({
          orgId: context.orgId,
          applicationId: id,
          expectedVersion: 1,
          operationKey: keys[index] ?? '',
          decision: { kind: 'fixed', amountCents: 700 },
        }),
      ),
    );
    const success = results.find((result) => result.status === 'fulfilled');
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    if (success?.status !== 'fulfilled')
      throw new Error('No aid award succeeded');
    const awardedIndex = applicationIds.indexOf(success.value.applicationId);
    expect(
      await awards.award({
        orgId: context.orgId,
        applicationId: success.value.applicationId,
        expectedVersion: 1,
        operationKey: keys[awardedIndex] ?? '',
        decision: { kind: 'fixed', amountCents: 700 },
      }),
    ).toEqual(success.value);
    await expect(
      awards.award({
        orgId: context.orgId,
        applicationId: success.value.applicationId,
        expectedVersion: 1,
        operationKey: randomUUID(),
        decision: { kind: 'fixed', amountCents: 700 },
      }),
    ).rejects.toThrow('already decided');
    const budget = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('financial_aid_programs')
        .select('awarded_cents')
        .where('org_id', '=', context.orgId)
        .where('id', '=', aidProgramId)
        .executeTakeFirstOrThrow(),
    );
    expect(budget.awarded_cents).toBe(700);
  });

  it('stores a percent award with a hard maximum reserved from a separate budget', async () => {
    const program = newId();
    const application = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('financial_aid_programs')
        .values({
          id: program,
          org_id: context.orgId,
          name: 'Percent aid',
          season_id: seasonId,
          budget_cents: 1000,
          status: 'open',
        })
        .execute();
      await trx
        .insertInto('aid_applications')
        .values({
          id: application,
          org_id: context.orgId,
          financial_aid_program_id: program,
          household_id: householdId,
          program_ids: [programId],
          requested_cents: 800,
          status: 'submitted',
        })
        .execute();
    });
    const result = await new PostgresAidAwards(database, context).award({
      orgId: context.orgId,
      applicationId: application,
      expectedVersion: 1,
      operationKey: randomUUID(),
      decision: { kind: 'percent', bps: 2500, maxCents: 600 },
    });
    expect(result).toMatchObject({
      status: 'partially_awarded',
      awardCents: 600,
      awardBps: 2500,
    });
    const budget = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('financial_aid_programs')
        .select('awarded_cents')
        .where('org_id', '=', context.orgId)
        .where('id', '=', program)
        .executeTakeFirstOrThrow(),
    );
    expect(budget.awarded_cents).toBe(600);
  });
});
