import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { createEmergencyContactsRepository } from '../src/modules/people/emergencyContacts';

import { createTestFactories } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => database.destroy());

it('keeps removed contacts and audits guardian edits with version and tenant checks', async () => {
  const factories = createTestFactories(database);
  const owner = await factories.actor();
  const guardian = await factories.actor();
  const outsider = await factories.actor();
  const childId = await factories.person(owner);
  await factories.scoped(owner, (trx) =>
    trx
      .insertInto('person_account_links')
      .values({
        id: newId(),
        org_id: owner.orgId,
        person_id: childId,
        account_id: guardian.accountId,
        relationship: 'guardian',
        verified_at: new Date(),
      })
      .execute()
      .then(() => undefined),
  );
  const contacts = createEmergencyContactsRepository(database);
  const first = await contacts.create(
    owner.orgId,
    guardian.accountId,
    childId,
    {
      name: 'Jordan Rivera',
      relationship: 'Parent',
      phoneE164: '+15555550123',
      altPhoneE164: null,
      priority: 1,
    },
  );
  await expect(
    contacts.create(owner.orgId, guardian.accountId, childId, {
      name: 'Other',
      relationship: 'Neighbor',
      phoneE164: '+15555550124',
      altPhoneE164: null,
      priority: 1,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    contacts.list(outsider.orgId, outsider.accountId, childId),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    await contacts.list(owner.orgId, guardian.accountId, childId),
  ).toMatchObject({
    canEdit: true,
    items: [{ name: 'Jordan Rivera', version: 1 }],
  });
  await contacts.update(owner.orgId, guardian.accountId, childId, first.id, {
    expectedVersion: 1,
    phoneE164: '+15555550125',
  });
  await expect(
    contacts.update(owner.orgId, guardian.accountId, childId, first.id, {
      expectedVersion: 1,
      name: 'Stale',
    }),
  ).rejects.toMatchObject({ status: 409 });
  await contacts.remove(owner.orgId, guardian.accountId, childId, first.id, 2);
  expect(
    (await contacts.list(owner.orgId, guardian.accountId, childId)).items,
  ).toHaveLength(0);
  const retained = await factories.scoped(owner, (trx) =>
    trx
      .selectFrom('emergency_contacts')
      .select(['removed_at', 'version'])
      .where('org_id', '=', owner.orgId)
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow(),
  );
  expect(retained.removed_at).not.toBeNull();
  expect(retained.version).toBe(3);
  await contacts.create(owner.orgId, guardian.accountId, childId, {
    name: 'Replacement',
    relationship: 'Parent',
    phoneE164: '+15555550126',
    altPhoneE164: null,
    priority: 1,
  });
  const audits = await factories.scoped(owner, (trx) =>
    trx
      .selectFrom('audit_log')
      .select('action')
      .where('org_id', '=', owner.orgId)
      .where('entity_type', '=', 'emergency_contact')
      .execute(),
  );
  expect(audits.map((row) => row.action)).toContain('emergency_contact.remove');
});

it('blocks removal of the last contact while a registration is active', async () => {
  const factories = createTestFactories(database);
  const owner = await factories.actor();
  const childId = await factories.person(owner);
  const householdId = await factories.household(owner);
  const program = await factories.program(owner);
  const contacts = createEmergencyContactsRepository(database);
  await factories.scoped(owner, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', owner.orgId)
      .where('account_id', '=', owner.accountId)
      .execute()
      .then(() => undefined),
  );
  const first = await contacts.create(owner.orgId, owner.accountId, childId, {
    name: 'Parent',
    relationship: 'Parent',
    phoneE164: '+15555550123',
    altPhoneE164: null,
    priority: 1,
  });
  await factories.registration(owner, program, childId, householdId);
  await expect(
    contacts.remove(owner.orgId, owner.accountId, childId, first.id, 1),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await contacts.list(owner.orgId, owner.accountId, childId)).items,
  ).toHaveLength(1);
});
