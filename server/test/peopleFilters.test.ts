import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { createPeopleRepository } from '../src/modules/people/repo';

import { createTestFactories } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('filters people by active program registration and current team roster', async () => {
  const factories = createTestFactories(database);
  const actor = await factories.actor();
  await factories.scoped(actor, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .where('account_id', '=', actor.accountId)
      .execute()
      .then(() => undefined),
  );
  const personId = await factories.person(actor);
  const otherId = await factories.person(actor, { firstName: 'Other' });
  const fixture = await factories.program(actor);
  const team = await factories.team(actor, fixture);
  const householdId = await factories.household(actor);
  const registrationId = await factories.registration(
    actor,
    fixture,
    personId,
    householdId,
  );
  const rosterDate = '2026-09-27';
  const rosterId = newId();
  await factories.row(actor, 'roster_entries', {
    id: rosterId,
    org_id: actor.orgId,
    team_season_id: team.teamSeasonId,
    person_id: personId,
    registration_id: registrationId,
    joined_on: rosterDate,
  });
  const people = createPeopleRepository(database);
  expect(
    (
      await people.filterOptions(actor.orgId, actor.accountId, {
        kind: 'program',
        q: 'Fixture',
      })
    ).items,
  ).toEqual([{ id: fixture.programId, name: 'Fixture League' }]);
  expect(
    (
      await people.filterOptions(actor.orgId, actor.accountId, {
        kind: 'team',
        q: 'Fixture',
      })
    ).items,
  ).toEqual([{ id: team.teamSeasonId, name: 'Fixture Team — Fixture League' }]);
  expect(
    (
      await people.list(actor.orgId, actor.accountId, {
        status: 'active',
        programId: fixture.programId,
        teamSeasonId: team.teamSeasonId,
        limit: 30,
      })
    ).items.map((person) => person.id),
  ).toEqual([personId]);
  expect(
    (
      await people.list(actor.orgId, actor.accountId, {
        status: 'active',
        programId: fixture.programId,
        limit: 30,
      })
    ).items.map((person) => person.id),
  ).not.toContain(otherId);
  await factories.scoped(actor, async (trx) => {
    await trx
      .updateTable('registrations')
      .set({ status: 'withdrawn' })
      .where('id', '=', registrationId)
      .execute();
    await trx
      .updateTable('roster_entries')
      .set({ status: 'released', left_on: rosterDate })
      .where('id', '=', rosterId)
      .execute();
  });
  expect(
    (
      await people.list(actor.orgId, actor.accountId, {
        status: 'active',
        programId: fixture.programId,
        limit: 30,
      })
    ).items,
  ).toEqual([]);
  expect(
    (
      await people.list(actor.orgId, actor.accountId, {
        status: 'active',
        teamSeasonId: team.teamSeasonId,
        limit: 30,
      })
    ).items,
  ).toEqual([]);
});

it('filters by the exact credential record status without implying role eligibility', async () => {
  const factories = createTestFactories(database);
  const actor = await factories.actor();
  await factories.scoped(actor, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .where('account_id', '=', actor.accountId)
      .execute()
      .then(() => undefined),
  );
  const credentialedId = await factories.person(actor, {
    firstName: 'Credentialed',
  });
  const noRecordId = await factories.person(actor, { firstName: 'NoRecord' });
  const typeId = newId();
  await factories.row(actor, 'credential_types', {
    id: typeId,
    org_id: actor.orgId,
    key: `people_${newId().replaceAll('-', '_')}`,
    name: 'People filter fixture',
    verification: 'manual_staff',
    validity: {},
    applies_to: {},
  });
  const credentialId = newId();
  await factories.row(actor, 'person_credentials', {
    id: credentialId,
    org_id: actor.orgId,
    person_id: credentialedId,
    credential_type_id: typeId,
    status: 'pending_review',
  });
  const people = createPeopleRepository(database);
  expect(
    (
      await people.list(actor.orgId, actor.accountId, {
        status: 'active',
        credentialStatus: 'pending_review',
        limit: 30,
      })
    ).items.map((person) => person.id),
  ).toEqual([credentialedId]);
  expect(
    (
      await people.list(actor.orgId, actor.accountId, {
        status: 'active',
        credentialStatus: 'none',
        limit: 30,
      })
    ).items.map((person) => person.id),
  ).toEqual([noRecordId]);
  await factories.scoped(actor, (trx) =>
    trx
      .updateTable('person_credentials')
      .set({ status: 'verified' })
      .where('id', '=', credentialId)
      .execute()
      .then(() => undefined),
  );
  expect(
    (
      await people.list(actor.orgId, actor.accountId, {
        status: 'active',
        credentialStatus: 'verified',
        limit: 30,
      })
    ).items.map((person) => person.id),
  ).toEqual([credentialedId]);
});
