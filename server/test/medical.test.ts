import { randomBytes } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { parseEncryptionKeys } from '../src/lib/crypto';
import { createMedicalRepository } from '../src/modules/people/medical';

import { createTestFactories } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => database.destroy());

it('encrypts medical details, audits every authorized read and limits coach and registrar visibility', async () => {
  const factories = createTestFactories(database);
  const owner = await factories.actor();
  const outsider = await factories.actor();
  const registrar = await factories.actor();
  const coach = await factories.actor();
  const childId = await factories.person(owner);
  const coachPersonId = await factories.person(owner, {
    dateOfBirth: '1980-01-01',
  });
  const program = await factories.program(owner);
  const team = await factories.team(owner, program);
  await factories.scoped(owner, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', owner.orgId)
      .where('account_id', '=', owner.accountId)
      .execute();
    await trx
      .insertInto('roster_entries')
      .values({
        id: newId(),
        org_id: owner.orgId,
        team_season_id: team.teamSeasonId,
        person_id: childId,
      })
      .execute();
    await trx
      .insertInto('team_staff')
      .values({
        id: newId(),
        org_id: owner.orgId,
        team_season_id: team.teamSeasonId,
        person_id: coachPersonId,
        role: 'head_coach',
        status: 'active',
        added_by: owner.accountId,
      })
      .execute();
    await trx
      .insertInto('person_account_links')
      .values({
        id: newId(),
        org_id: owner.orgId,
        person_id: coachPersonId,
        account_id: coach.accountId,
        relationship: 'self',
        verified_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: owner.orgId,
        account_id: registrar.accountId,
        status: 'active',
        joined_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('role_assignments')
      .values({
        id: newId(),
        org_id: owner.orgId,
        account_id: registrar.accountId,
        role: 'registrar',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
  });
  const encryption = parseEncryptionKeys(
    JSON.stringify({ test: randomBytes(32).toString('base64') }),
    'test',
  );
  const medical = createMedicalRepository(database, encryption);
  expect(
    (await medical.read(owner.orgId, owner.accountId, childId)).version,
  ).toBe(0);
  await medical.write(owner.orgId, owner.accountId, childId, {
    expectedVersion: 0,
    allergies: 'Severe peanut allergy',
    allergyFlags: ['peanut', 'epipen'],
    conditions: 'Asthma',
    medications: 'Inhaler',
    physicianName: 'Dr. Example',
    physicianPhone: '+15555550123',
    insuranceCarrier: 'Example Insurance',
    insurancePolicy: 'POL-123',
    notes: 'Call guardian first',
  });
  const stored = await factories.scoped(owner, (trx) =>
    trx
      .selectFrom('medical_profiles')
      .select(['allergies_enc', 'version'])
      .where('org_id', '=', owner.orgId)
      .where('person_id', '=', childId)
      .executeTakeFirstOrThrow(),
  );
  expect(stored.version).toBe(1);
  expect(
    stored.allergies_enc?.includes(Buffer.from('Severe peanut allergy')),
  ).toBe(false);
  await expect(
    medical.read(outsider.orgId, outsider.accountId, childId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    medical.read(owner.orgId, registrar.accountId, childId),
  ).rejects.toMatchObject({ status: 404 });
  const flags = await medical.read(owner.orgId, coach.accountId, childId);
  expect(flags).toMatchObject({
    visibility: 'flags_only',
    canEdit: false,
    allergyFlags: ['epipen', 'peanut'],
    allergies: null,
  });
  await expect(
    medical.write(owner.orgId, coach.accountId, childId, {
      expectedVersion: 1,
      allergies: null,
      allergyFlags: [],
      conditions: null,
      medications: null,
      physicianName: null,
      physicianPhone: null,
      insuranceCarrier: null,
      insurancePolicy: null,
      notes: null,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await factories.scoped(owner, (trx) =>
    trx
      .updateTable('organizations')
      .set({
        settings: { coachMedicalAccess: 'full', registrarMedicalAccess: true },
      })
      .where('id', '=', owner.orgId)
      .execute()
      .then(() => undefined),
  );
  expect(
    await medical.read(owner.orgId, coach.accountId, childId),
  ).toMatchObject({
    visibility: 'full',
    canEdit: false,
    allergies: 'Severe peanut allergy',
  });
  expect(
    await medical.read(owner.orgId, registrar.accountId, childId),
  ).toMatchObject({ visibility: 'full', allergies: 'Severe peanut allergy' });
  const reads = await factories.scoped(owner, (trx) =>
    trx
      .selectFrom('audit_log')
      .select('id')
      .where('org_id', '=', owner.orgId)
      .where('entity_type', '=', 'medical_profile')
      .where('action', '=', 'medical.read')
      .execute(),
  );
  expect(reads).toHaveLength(4);
});

it('allows a guardian to edit while a linked minor can only read', async () => {
  const factories = createTestFactories(database);
  const owner = await factories.actor();
  const guardian = await factories.actor();
  const athlete = await factories.actor();
  const childId = await factories.person(owner, { dateOfBirth: '2011-01-01' });
  await factories.scoped(owner, async (trx) => {
    for (const [accountId, relationship] of [
      [guardian.accountId, 'guardian'],
      [athlete.accountId, 'self'],
    ] as const) {
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: owner.orgId,
          person_id: childId,
          account_id: accountId,
          relationship,
          verified_at: new Date(),
        })
        .execute();
    }
  });
  const encryption = parseEncryptionKeys(
    JSON.stringify({ test: randomBytes(32).toString('base64') }),
    'test',
  );
  const medical = createMedicalRepository(database, encryption);
  await medical.write(owner.orgId, guardian.accountId, childId, {
    expectedVersion: 0,
    allergies: 'Peanuts',
    allergyFlags: ['peanut'],
    conditions: null,
    medications: null,
    physicianName: null,
    physicianPhone: null,
    insuranceCarrier: null,
    insurancePolicy: null,
    notes: null,
  });
  expect(
    await medical.read(owner.orgId, athlete.accountId, childId),
  ).toMatchObject({ visibility: 'full', canEdit: false, allergies: 'Peanuts' });
  await expect(
    medical.write(owner.orgId, athlete.accountId, childId, {
      expectedVersion: 1,
      allergies: null,
      allergyFlags: [],
      conditions: null,
      medications: null,
      physicianName: null,
      physicianPhone: null,
      insuranceCarrier: null,
      insurancePolicy: null,
      notes: null,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await factories.scoped(owner, (trx) =>
    trx
      .updateTable('person_account_links')
      .set({ revoked_at: new Date() })
      .where('org_id', '=', owner.orgId)
      .where('account_id', '=', guardian.accountId)
      .where('person_id', '=', childId)
      .execute()
      .then(() => undefined),
  );
  await expect(
    medical.read(owner.orgId, guardian.accountId, childId),
  ).rejects.toMatchObject({ status: 404 });
});
