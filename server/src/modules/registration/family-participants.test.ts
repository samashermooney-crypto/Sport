import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg } from '../../db/withOrg.js';

import { addFamilyParticipant } from './family-participants.js';

let database: Kysely<DB>;
const orgId = newId();
const parentId = newId();
const minorAccountId = newId();

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  await database
    .insertInto('accounts')
    .values([
      {
        id: parentId,
        email: `family-${randomUUID()}@example.invalid`,
        first_name: 'Rosa',
        last_name: 'Ortega',
        date_of_birth: '1986-04-02',
        email_verified_at: new Date(),
      },
      {
        id: minorAccountId,
        email: `teen-${randomUUID()}@example.invalid`,
        first_name: 'Teen',
        last_name: 'Account',
        date_of_birth: '2011-04-02',
        email_verified_at: new Date(),
      },
    ])
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `family-${randomUUID().slice(0, 12)}`,
      name: 'Family Add Test',
      kind: 'league',
      timezone: 'America/Chicago',
    })
    .execute();
});

afterAll(async () => {
  await database.destroy();
});

describe('family adds their own children', () => {
  it('creates the guardian profile, one household and guardian-linked children without duplicates', async () => {
    const first = await addFamilyParticipant(database, orgId, parentId, {
      firstName: 'Mateo',
      lastName: 'Ortega',
      dateOfBirth: '2016-05-10',
    });
    const second = await addFamilyParticipant(database, orgId, parentId, {
      firstName: 'Lucia',
      lastName: 'Ortega',
      dateOfBirth: '2018-09-01',
      gender: 'female',
    });
    expect(first).toMatchObject({ name: 'Mateo Ortega', created: true });
    expect(second.householdId).toBe(first.householdId);
    expect(
      await addFamilyParticipant(database, orgId, parentId, {
        firstName: 'mateo',
        lastName: 'ORTEGA',
        dateOfBirth: '2016-05-10',
      }),
    ).toEqual({ ...first, created: false });

    const state = await createWithOrg(database)(
      { orgId, actor: { accountId: parentId } },
      async (trx) => ({
        links: await trx
          .selectFrom('person_account_links')
          .select(['person_id', 'relationship'])
          .where('org_id', '=', orgId)
          .where('account_id', '=', parentId)
          .where('verified_at', 'is not', null)
          .orderBy('relationship')
          .execute(),
        members: await trx
          .selectFrom('household_members')
          .select(['person_id', 'role', 'is_primary_contact'])
          .where('org_id', '=', orgId)
          .where('household_id', '=', first.householdId)
          .execute(),
        audit: await trx
          .selectFrom('audit_log')
          .select('entity_id')
          .where('org_id', '=', orgId)
          .where('action', '=', 'person.family_added')
          .execute(),
      }),
    );
    const guardianLinks = state.links.filter(
      (link) => link.relationship === 'guardian',
    );
    expect(guardianLinks.map((link) => link.person_id).sort()).toEqual(
      [first.personId, second.personId].sort(),
    );
    const self = state.links.find((link) => link.relationship === 'self');
    expect(self).toBeDefined();
    expect(state.members).toHaveLength(3);
    expect(state.members).toContainEqual({
      person_id: self?.person_id,
      role: 'guardian',
      is_primary_contact: true,
    });
    expect(state.audit).toHaveLength(2);
  });

  it('refuses adults, future birthdays and minor account holders', async () => {
    await expect(
      addFamilyParticipant(database, orgId, parentId, {
        firstName: 'Grown',
        lastName: 'Ortega',
        dateOfBirth: '2000-01-01',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Adults register with their own account',
    });
    await expect(
      addFamilyParticipant(database, orgId, parentId, {
        firstName: 'Future',
        lastName: 'Ortega',
        dateOfBirth: '2999-01-01',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      addFamilyParticipant(database, orgId, minorAccountId, {
        firstName: 'Sibling',
        lastName: 'Account',
        dateOfBirth: '2019-01-01',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Guardian account must be an adult',
    });
  });
});
