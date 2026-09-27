import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresAidAwards } from './aid-awards.js';
import { PostgresAidPrograms } from './aid-programs.js';

let database: Kysely<DB>;
let context: OrgContext;
let seasonId: string;
let householdId: string;
let formId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  seasonId = newId();
  householdId = newId();
  formId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `aid-program-${randomUUID()}@example.invalid`,
      first_name: 'Aid',
      last_name: 'Manager',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `aid-program-${randomUUID().slice(0, 12)}`,
      name: 'Aid Fund Test',
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
      .insertInto('form_definitions')
      .values({
        id: formId,
        org_id: orgId,
        name: 'Aid form',
        scope: 'custom',
        schema: {},
        published_at: new Date(),
      })
      .execute();
  });
});
afterAll(async () => {
  await database.destroy();
});

describe('aid program configuration', () => {
  it('replays creation, requires a published form and keeps the budget above awards', async () => {
    const repo = new PostgresAidPrograms(database, context);
    const key = randomUUID();
    const input = {
      name: 'Season help',
      seasonId,
      applicationFormId: null,
      budgetCents: 500,
    };
    const draft = await repo.create(input, key);
    expect(await repo.create(input, key)).toEqual(draft);
    await expect(
      repo.create({ ...input, budgetCents: 501 }, key),
    ).rejects.toThrow('key was reused');
    await expect(
      repo.replace(draft.id, {
        name: draft.name,
        applicationFormId: null,
        budgetCents: 500,
        expectedVersion: 1,
        status: 'open',
      }),
    ).rejects.toThrow('Published aid form');
    await repo.replace(draft.id, {
      name: draft.name,
      applicationFormId: formId,
      budgetCents: 500,
      expectedVersion: 1,
      status: 'open',
    });
    const applicationId = newId();
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('aid_applications')
        .values({
          id: applicationId,
          org_id: context.orgId,
          financial_aid_program_id: draft.id,
          household_id: householdId,
          requested_cents: 400,
          status: 'submitted',
        })
        .execute(),
    );
    await new PostgresAidAwards(database, context).award({
      orgId: context.orgId,
      applicationId,
      expectedVersion: 1,
      operationKey: randomUUID(),
      decision: { kind: 'fixed', amountCents: 400 },
    });
    const current = (await repo.list(seasonId)).find(
      (item) => item.id === draft.id,
    );
    if (!current) throw new Error('Aid fund is missing');
    await expect(
      repo.replace(draft.id, {
        name: 'Lower fund',
        applicationFormId: formId,
        budgetCents: 399,
        expectedVersion: current.version,
        status: 'open',
      }),
    ).rejects.toThrow('below reserved awards');
    const listed = await repo.list(seasonId);
    expect(listed).toContainEqual(
      expect.objectContaining({
        id: draft.id,
        budgetCents: 500,
        awardedCents: 400,
      }),
    );
  });
});
