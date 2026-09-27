import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { listFamily } from '../src/modules/people/family';

import { createTestFactories } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('shows one verified guardian two organizations while filtering revoked and archived links', async () => {
  const factories = createTestFactories(database);
  const firstOrg = await factories.actor();
  const secondOrg = await factories.actor();
  const childA = await factories.person(firstOrg, { firstName: 'Amara' });
  const childB = await factories.person(secondOrg, { firstName: 'Bri' });
  const hiddenChild = await factories.person(firstOrg, { firstName: 'Hidden' });
  const guardianId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: guardianId,
      email: `family-${randomUUID()}@example.invalid`,
      first_name: 'Family',
      last_name: 'Guardian',
      date_of_birth: '1980-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  for (const [org, personId] of [
    [firstOrg, childA],
    [secondOrg, childB],
  ] as const) {
    await factories.row(org, 'person_account_links', {
      id: newId(),
      org_id: org.orgId,
      person_id: personId,
      account_id: guardianId,
      relationship: 'guardian',
      verified_at: new Date(),
    });
  }
  await factories.row(firstOrg, 'person_account_links', {
    id: newId(),
    org_id: firstOrg.orgId,
    person_id: hiddenChild,
    account_id: guardianId,
    relationship: 'guardian',
    verified_at: null,
  });
  const indexed = await database
    .selectFrom('accounts')
    .select('linked_org_ids')
    .where('id', '=', guardianId)
    .executeTakeFirstOrThrow();
  expect(indexed.linked_org_ids.sort()).toEqual(
    [firstOrg.orgId, secondOrg.orgId].sort(),
  );
  const family = await listFamily(database, guardianId);
  expect(family.organizations).toHaveLength(2);
  expect(
    family.organizations
      .flatMap((org) => org.people.map((person) => person.firstName))
      .sort(),
  ).toEqual(['Amara', 'Bri']);
  await factories.scoped(firstOrg, async (trx) => {
    await trx
      .updateTable('person_account_links')
      .set({ revoked_at: new Date() })
      .where('org_id', '=', firstOrg.orgId)
      .where('person_id', '=', childA)
      .where('account_id', '=', guardianId)
      .execute();
  });
  expect(
    (await listFamily(database, guardianId)).organizations.map(
      (org) => org.orgId,
    ),
  ).toEqual([secondOrg.orgId]);
  await factories.scoped(secondOrg, async (trx) => {
    await trx
      .updateTable('people')
      .set({ status: 'archived' })
      .where('org_id', '=', secondOrg.orgId)
      .where('id', '=', childB)
      .execute();
  });
  expect((await listFamily(database, guardianId)).organizations).toEqual([]);
});
