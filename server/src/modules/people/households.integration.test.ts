import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';

import { createHouseholdsRepository } from './households';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('scopes household members and preserves primary contact, version and audit', async () => {
  const withOrg = createWithOrg(database);
  async function actor() {
    const orgId = newId();
    const accountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `household-${randomUUID()}@example.invalid`,
        first_name: 'Test',
        last_name: 'Owner',
        date_of_birth: '1980-01-01',
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `household-${randomUUID().slice(0, 12)}`,
        name: 'Household Test',
        kind: 'club',
        timezone: 'UTC',
      })
      .execute();
    const context = { orgId, accountId, actor: { accountId } };
    await withOrg(context, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: accountId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: accountId,
          role: 'owner',
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    });
    return context;
  }
  async function person(
    context: Awaited<ReturnType<typeof actor>>,
    firstName: string,
    dateOfBirth: string,
  ) {
    const id = newId();
    await withOrg(context, (trx) =>
      trx
        .insertInto('people')
        .values({
          id,
          org_id: context.orgId,
          first_name: firstName,
          last_name: 'Rivera',
          date_of_birth: dateOfBirth,
        })
        .execute()
        .then(() => undefined),
    );
    return id;
  }
  const owner = await actor();
  const outsider = await actor();
  const guardian = await person(owner, 'Riley', '1980-01-01');
  const child = await person(owner, 'Alex', '2012-01-01');
  const otherTenantPerson = await person(outsider, 'Other', '2012-01-01');
  const repo = createHouseholdsRepository(database);
  const created = await repo.create(owner.orgId, owner.accountId, {
    name: 'Rivera family',
    address: null,
  });
  expect(created).toMatchObject({
    name: 'Rivera family',
    version: 1,
    members: [],
    balances: [],
  });
  await expect(
    repo.get(outsider.orgId, outsider.accountId, created.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    repo.addMember(owner.orgId, owner.accountId, created.id, {
      personId: otherTenantPerson,
      role: 'athlete',
      isPrimaryContact: false,
      receivesCommunications: false,
      financiallyResponsible: false,
      canPickUp: false,
      livesHere: true,
    }),
  ).rejects.toMatchObject({ status: 404 });
  const withGuardian = await repo.addMember(
    owner.orgId,
    owner.accountId,
    created.id,
    {
      personId: guardian,
      role: 'guardian',
      isPrimaryContact: true,
      receivesCommunications: true,
      financiallyResponsible: true,
      canPickUp: true,
      livesHere: true,
    },
  );
  expect(withGuardian.members).toMatchObject([
    {
      personId: guardian,
      isPrimaryContact: true,
    },
  ]);
  const withChild = await repo.addMember(
    owner.orgId,
    owner.accountId,
    created.id,
    {
      personId: child,
      role: 'athlete',
      isPrimaryContact: false,
      receivesCommunications: false,
      financiallyResponsible: false,
      canPickUp: false,
      livesHere: true,
    },
  );
  expect(withChild.members).toHaveLength(2);
  await expect(
    repo.addMember(owner.orgId, owner.accountId, created.id, {
      personId: child,
      role: 'athlete',
      isPrimaryContact: true,
      receivesCommunications: false,
      financiallyResponsible: false,
      canPickUp: false,
      livesHere: true,
    }),
  ).rejects.toMatchObject({ status: 400 });
  const edited = await repo.update(owner.orgId, owner.accountId, created.id, {
    expectedVersion: 3,
    name: 'Rivera household',
  });
  expect(edited).toMatchObject({ name: 'Rivera household', version: 4 });
  await expect(
    repo.update(owner.orgId, owner.accountId, created.id, {
      expectedVersion: 3,
      name: 'Stale',
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await repo.list(owner.orgId, owner.accountId)).items.map(
      (item) => item.id,
    ),
  ).toContain(created.id);
  const audit = await withOrg(owner, (trx) =>
    trx
      .selectFrom('audit_log')
      .select('action')
      .where('org_id', '=', owner.orgId)
      .where('entity_id', '=', created.id)
      .orderBy('created_at')
      .execute(),
  );
  expect(audit.map((row) => row.action)).toEqual([
    'household.created',
    'household.member_added',
    'household.member_added',
    'household.updated',
  ]);
});
