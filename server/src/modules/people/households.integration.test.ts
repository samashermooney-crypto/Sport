import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
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
  const secondAdult = await person(owner, 'Morgan', '1982-01-01');
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

  const seasonId = newId();
  const sportProfileId = newId();
  const programId = newId();
  const divisionId = newId();
  const offeringId = newId();
  const registrationId = newId();
  const invoiceIds = [newId(), newId(), newId()];
  await withOrg(owner, async (trx) => {
    await trx
      .insertInto('seasons')
      .values({
        id: seasonId,
        org_id: owner.orgId,
        name: 'Household Acceptance Season',
        starts_on: '2026-01-01',
        ends_on: '2026-12-31',
      })
      .execute();
    await trx
      .insertInto('sport_profiles')
      .values({
        id: sportProfileId,
        org_id: owner.orgId,
        name: 'Soccer',
        profile: builtInSportTemplates[0],
      })
      .execute();
    await trx
      .insertInto('programs')
      .values({
        id: programId,
        org_id: owner.orgId,
        season_id: seasonId,
        sport_profile_id: sportProfileId,
        mode: 'league',
        name: 'Household Acceptance League',
        slug: `household-${randomUUID().slice(0, 8)}`,
        starts_on: '2026-03-01',
        ends_on: '2026-11-30',
      })
      .execute();
    await trx
      .insertInto('divisions')
      .values({
        id: divisionId,
        org_id: owner.orgId,
        program_id: programId,
        name: 'Open',
        level: 'open',
      })
      .execute();
    await trx
      .insertInto('registration_offerings')
      .values({
        id: offeringId,
        org_id: owner.orgId,
        program_id: programId,
        division_id: divisionId,
        name: 'Player',
        registrant_role: 'athlete',
        price_cents: 0,
      })
      .execute();
    await trx
      .insertInto('registrations')
      .values({
        id: registrationId,
        org_id: owner.orgId,
        program_id: programId,
        division_id: divisionId,
        offering_id: offeringId,
        person_id: child,
        household_id: created.id,
        registered_by_account_id: owner.accountId,
        source: 'staff',
        status: 'confirmed',
      })
      .execute();
    for (const [index, id] of invoiceIds.entries()) {
      const amount = index === 0 ? 7_500 : index === 1 ? 2_500 : 5_000;
      await trx
        .insertInto('invoices')
        .values({
          id,
          org_id: owner.orgId,
          number: 900 + index,
          account_id: owner.accountId,
          household_id: created.id,
          status: index === 2 ? 'draft' : 'open',
          source: 'staff',
          subtotal_cents: amount,
          total_cents: amount,
        })
        .execute();
    }
  });
  const populatedHousehold = await repo.get(
    owner.orgId,
    owner.accountId,
    created.id,
  );
  expect(populatedHousehold.registrations).toEqual([
    {
      id: registrationId,
      personId: child,
      programId,
      status: 'confirmed',
    },
  ]);
  expect(populatedHousehold.balances).toEqual([
    { currency: 'USD', amountCents: 10_000 },
  ]);

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
  const childMember = withChild.members.find(
    (member) => member.personId === child,
  );
  const guardianMember = withChild.members.find(
    (member) => member.personId === guardian,
  );
  expect(childMember).toBeDefined();
  expect(guardianMember).toBeDefined();
  if (!childMember || !guardianMember)
    throw new Error('Expected household members');
  const withEditedChild = await repo.updateMember(
    owner.orgId,
    owner.accountId,
    created.id,
    childMember.id,
    { expectedVersion: 4, canPickUp: true },
  );
  expect(
    withEditedChild.members.find((member) => member.personId === child)
      ?.canPickUp,
  ).toBe(true);
  await expect(
    repo.removeMember(
      owner.orgId,
      owner.accountId,
      created.id,
      guardianMember.id,
      5,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const withoutChild = await repo.removeMember(
    owner.orgId,
    owner.accountId,
    created.id,
    childMember.id,
    5,
  );
  expect(withoutChild.members.map((member) => member.personId)).not.toContain(
    child,
  );
  const historical = await withOrg(owner, (trx) =>
    trx
      .selectFrom('household_members')
      .select('removed_at')
      .where('org_id', '=', owner.orgId)
      .where('id', '=', childMember.id)
      .executeTakeFirstOrThrow(),
  );
  expect(historical.removed_at).not.toBeNull();
  const readded = await repo.addMember(
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
  expect(
    readded.members.find((member) => member.personId === child)?.id,
  ).not.toBe(childMember.id);
  const withSecondAdult = await repo.addMember(
    owner.orgId,
    owner.accountId,
    created.id,
    {
      personId: secondAdult,
      role: 'other_adult',
      isPrimaryContact: false,
      receivesCommunications: true,
      financiallyResponsible: false,
      canPickUp: true,
      livesHere: true,
    },
  );
  const secondMember = withSecondAdult.members.find(
    (member) => member.personId === secondAdult,
  );
  expect(secondMember).toBeDefined();
  if (!secondMember) throw new Error('Expected second adult member');
  const reassigned = await repo.updateMember(
    owner.orgId,
    owner.accountId,
    created.id,
    secondMember.id,
    { expectedVersion: 8, isPrimaryContact: true },
  );
  expect(
    reassigned.members
      .filter((member) => member.isPrimaryContact)
      .map((member) => member.personId),
  ).toEqual([secondAdult]);
  const withoutGuardian = await repo.removeMember(
    owner.orgId,
    owner.accountId,
    created.id,
    guardianMember.id,
    9,
  );
  expect(
    withoutGuardian.members.map((member) => member.personId),
  ).not.toContain(guardian);
  expect(
    (await repo.list(owner.orgId, owner.accountId)).items.map(
      (item) => item.id,
    ),
  ).toContain(created.id);
  expect(
    (await repo.list(owner.orgId, owner.accountId, { q: 'Rivera' })).items.map(
      (item) => item.id,
    ),
  ).toContain(created.id);
  expect(
    (await repo.list(owner.orgId, owner.accountId, { q: 'No match' })).items,
  ).toEqual([]);
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
    'household.member_updated',
    'household.member_removed',
    'household.member_added',
    'household.member_added',
    'household.member_updated',
    'household.member_removed',
  ]);
});
