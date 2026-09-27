import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { createGuardianLinksRepository } from '../src/modules/people/guardianLinks';

import { createTestFactories } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('links verified adult accounts within the organization and retains a revocation audit', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  const otherOrg = await factories.actor();
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', staff.orgId)
      .where('account_id', '=', staff.accountId)
      .execute();
  });
  const childId = await factories.person(staff);
  const foreignChildId = await factories.person(otherOrg);
  const adultId = newId();
  const email = `guardian-${randomUUID()}@example.invalid`;
  await database
    .insertInto('accounts')
    .values({
      id: adultId,
      email,
      first_name: 'Jordan',
      last_name: 'Guardian',
      date_of_birth: '1980-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  const guardians = createGuardianLinksRepository(database);
  await expect(
    guardians.linkExisting(staff.orgId, staff.accountId, foreignChildId, email),
  ).rejects.toMatchObject({ status: 404 });
  const linked = await guardians.linkExisting(
    staff.orgId,
    staff.accountId,
    childId,
    email,
  );
  expect(linked.items).toHaveLength(1);
  expect(linked.items[0]?.email).toBe(email);
  await expect(
    guardians.linkExisting(staff.orgId, staff.accountId, childId, email),
  ).rejects.toMatchObject({ status: 409 });
  const revoked = await guardians.revoke(
    staff.orgId,
    staff.accountId,
    childId,
    linked.items[0]?.id ?? '',
  );
  expect(revoked.items).toEqual([]);
  const audit = await factories.scoped(staff, (trx) =>
    trx
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', childId)
      .where('action', 'like', 'person.guardian_%')
      .orderBy('created_at')
      .execute(),
  );
  expect(audit.map((entry) => entry.action)).toEqual([
    'person.guardian_linked',
    'person.guardian_revoked',
  ]);
});

it('rejects unverified and underage accounts and protects a linked minor from losing the final guardian', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', staff.orgId)
      .where('account_id', '=', staff.accountId)
      .execute();
  });
  const childId = await factories.person(staff);
  const guardians = createGuardianLinksRepository(database);
  const youngEmail = `young-${randomUUID()}@example.invalid`;
  await database
    .insertInto('accounts')
    .values({
      id: newId(),
      email: youngEmail,
      first_name: 'Young',
      last_name: 'Account',
      date_of_birth: '2015-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await expect(
    guardians.linkExisting(staff.orgId, staff.accountId, childId, youngEmail),
  ).rejects.toMatchObject({ status: 400 });
  const pendingEmail = `pending-${randomUUID()}@example.invalid`;
  await database
    .insertInto('accounts')
    .values({
      id: newId(),
      email: pendingEmail,
      first_name: 'Pending',
      last_name: 'Account',
      date_of_birth: '1980-01-01',
    })
    .execute();
  await expect(
    guardians.linkExisting(staff.orgId, staff.accountId, childId, pendingEmail),
  ).rejects.toMatchObject({ status: 404 });
  const guardianId = newId();
  const guardianEmail = `adult-${randomUUID()}@example.invalid`;
  await database
    .insertInto('accounts')
    .values({
      id: guardianId,
      email: guardianEmail,
      first_name: 'Adult',
      last_name: 'Guardian',
      date_of_birth: '1980-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  const linked = await guardians.linkExisting(
    staff.orgId,
    staff.accountId,
    childId,
    guardianEmail,
  );
  const athleteId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: athleteId,
      email: `athlete-${randomUUID()}@example.invalid`,
      first_name: 'Athlete',
      last_name: 'Account',
      date_of_birth: '2012-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await factories.row(staff, 'person_account_links', {
    id: newId(),
    org_id: staff.orgId,
    person_id: childId,
    account_id: athleteId,
    relationship: 'self',
    verified_at: new Date(),
  });
  await expect(
    guardians.revoke(
      staff.orgId,
      staff.accountId,
      childId,
      linked.items[0]?.id ?? '',
    ),
  ).rejects.toMatchObject({ status: 409 });
});
