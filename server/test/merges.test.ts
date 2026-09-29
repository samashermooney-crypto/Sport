import { randomUUID } from 'node:crypto';

import { createWaiversService } from '@server/modules/waivers/service';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { createMergesRepository } from '../src/modules/people/merges';

import { createTestFactories } from './factories';
import type { ActorFixture } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

async function staffActor(
  factories: ReturnType<typeof createTestFactories>,
): Promise<ActorFixture> {
  const staff = await factories.actor();
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', staff.orgId)
      .where('account_id', '=', staff.accountId)
      .execute();
  });
  return staff;
}

it('flags duplicate people by shared email, phone and similar name at the same birth date', async () => {
  const factories = createTestFactories(database);
  const staff = await staffActor(factories);
  const otherOrg = await factories.actor();
  const merges = createMergesRepository(database);
  const email = `dup-${randomUUID()}@example.invalid`;
  const phone = `+1555${String(Math.floor(Math.random() * 9000000) + 1000000)}`;
  const sameEmailA = await factories.person(staff, {
    firstName: 'Jordan',
    lastName: 'Email',
  });
  const sameEmailB = await factories.person(staff, {
    firstName: 'Different',
    lastName: 'Name',
    dateOfBirth: '2015-06-06',
  });
  const samePhoneA = await factories.person(staff, {
    firstName: 'Casey',
    lastName: 'Phone',
  });
  const samePhoneB = await factories.person(staff, {
    firstName: 'Riley',
    lastName: 'Phone',
    dateOfBirth: '2014-04-04',
  });
  const similarA = await factories.person(staff, {
    firstName: 'Sam',
    lastName: 'Rivera',
    dateOfBirth: '2012-05-05',
  });
  const similarB = await factories.person(staff, {
    firstName: 'Samuel',
    lastName: 'Rivera',
    dateOfBirth: '2012-05-05',
  });
  const distinctA = await factories.person(staff, {
    firstName: 'Unique',
    lastName: 'Person',
    dateOfBirth: '2011-01-01',
  });
  const distinctB = await factories.person(staff, {
    firstName: 'Other',
    lastName: 'Human',
    dateOfBirth: '2013-03-03',
  });
  const foreignA = await factories.person(otherOrg, {
    firstName: 'Sam',
    lastName: 'Rivera',
    dateOfBirth: '2012-05-05',
  });
  await factories.person(otherOrg, {
    firstName: 'Samuel',
    lastName: 'Rivera',
    dateOfBirth: '2012-05-05',
  });
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('people')
      .set({ email })
      .where('id', 'in', [sameEmailA, sameEmailB])
      .execute();
    await trx
      .updateTable('people')
      .set({ phone_e164: phone })
      .where('id', 'in', [samePhoneA, samePhoneB])
      .execute();
  });
  await factories.scoped(otherOrg, async (trx) => {
    await trx
      .updateTable('people')
      .set({ email })
      .where('id', '=', foreignA)
      .execute();
  });

  const result = await merges.duplicates(staff.orgId, staff.accountId);
  const pairFor = (first: string, second: string) =>
    result.items.find(
      (pair) =>
        (pair.a.id === first && pair.b.id === second) ||
        (pair.a.id === second && pair.b.id === first),
    );
  expect(pairFor(sameEmailA, sameEmailB)?.reason).toBe('same_email');
  expect(pairFor(samePhoneA, samePhoneB)?.reason).toBe('same_phone');
  expect(pairFor(similarA, similarB)?.reason).toBe('similar_name_birth_date');
  expect(pairFor(distinctA, distinctB)).toBeUndefined();
  expect(
    result.items.some(
      (pair) => pair.a.id === foreignA || pair.b.id === foreignA,
    ),
  ).toBe(false);

  await expect(
    merges.duplicates(staff.orgId, otherOrg.accountId),
  ).rejects.toMatchObject({ status: 404 });
});

it('moves registrations, memberships, credentials, responses, invoice lines and attendance to the survivor', async () => {
  const factories = createTestFactories(database);
  const staff = await staffActor(factories);
  const merges = createMergesRepository(database);
  const survivorId = await factories.person(staff, {
    firstName: 'Sam',
    lastName: 'Rivera',
    dateOfBirth: '2012-05-05',
  });
  const mergedId = await factories.person(staff, {
    firstName: 'Samuel',
    lastName: 'Rivera',
    dateOfBirth: '2012-05-05',
  });
  const fixture = await factories.program(staff);
  const householdA = await factories.household(staff);
  const householdB = await factories.household(staff);
  await factories.row(staff, 'household_members', {
    id: newId(),
    org_id: staff.orgId,
    household_id: householdA,
    person_id: survivorId,
    role: 'athlete',
  });
  await factories.row(staff, 'household_members', {
    id: newId(),
    org_id: staff.orgId,
    household_id: householdA,
    person_id: mergedId,
    role: 'athlete',
  });
  await factories.row(staff, 'household_members', {
    id: newId(),
    org_id: staff.orgId,
    household_id: householdB,
    person_id: mergedId,
    role: 'athlete',
  });
  await factories.registration(staff, fixture, mergedId, householdB);
  const invoiceId = await factories.invoice(staff, 9901);
  await factories.row(staff, 'invoice_lines', {
    id: newId(),
    org_id: staff.orgId,
    invoice_id: invoiceId,
    person_id: mergedId,
    kind: 'registration',
    description: 'Fixture fee',
    amount_cents: 500,
    unit_amount_cents: 500,
  });
  const credentialTypeId = newId();
  await factories.row(staff, 'credential_types', {
    id: credentialTypeId,
    org_id: staff.orgId,
    key: `volunteer_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
    name: 'Volunteer clearance',
    verification: 'manual_staff',
    applies_to: JSON.stringify(['volunteer']),
    validity: { kind: 'never' },
  });
  await factories.row(staff, 'person_credentials', {
    id: newId(),
    org_id: staff.orgId,
    person_id: mergedId,
    credential_type_id: credentialTypeId,
  });
  const formId = newId();
  await factories.row(staff, 'form_definitions', {
    id: formId,
    org_id: staff.orgId,
    scope: 'person_profile',
    name: 'Profile form',
    schema: { fields: [] },
  });
  await factories.row(staff, 'form_responses', {
    id: newId(),
    org_id: staff.orgId,
    form_definition_id: formId,
    definition_version: 1,
    subject_type: 'person',
    subject_id: mergedId,
    answers: { note: 'from merged' },
    submitted_by_account_id: staff.accountId,
  });
  const eventId = await factories.event(staff);
  await factories.row(staff, 'attendance', {
    id: newId(),
    org_id: staff.orgId,
    event_id: eventId,
    person_id: mergedId,
    status: 'present',
  });
  await factories.row(staff, 'emergency_contacts', {
    id: newId(),
    org_id: staff.orgId,
    person_id: mergedId,
    name: 'Merged Contact',
    relationship: 'parent',
    phone_e164: '+15555550100',
    priority: 1,
  });
  const guardianId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: guardianId,
      email: `guardian-${randomUUID()}@example.invalid`,
      first_name: 'Guardian',
      last_name: 'Shared',
      date_of_birth: '1980-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  for (const personId of [survivorId, mergedId]) {
    await factories.row(staff, 'person_account_links', {
      id: newId(),
      org_id: staff.orgId,
      person_id: personId,
      account_id: guardianId,
      relationship: 'guardian',
      verified_at: new Date(),
    });
  }
  const waivers = createWaiversService(database);
  const waiver = await waivers.create(staff, {
    name: 'Merge preservation waiver',
    bodyText: 'I understand and accept the participation safety terms.',
    requires: 'guardian_if_minor',
    renewal: 'annual_season',
  });
  await waivers.publish(staff, waiver.id, waiver.version);
  const guardian = {
    orgId: staff.orgId,
    actor: { accountId: guardianId },
  };
  const signature = await waivers.sign(
    guardian,
    waiver.id,
    {
      participantPersonId: mergedId,
      signerPersonId: null,
      signerNameTyped: 'Guardian Shared',
      method: 'online_typed',
      signatureFileId: null,
      registrationId: null,
    },
    { ip: null, userAgent: null },
  );

  const result = await merges.merge(
    staff.orgId,
    staff.accountId,
    survivorId,
    mergedId,
  );
  expect(result.survivorId).toBe(survivorId);
  expect(result.summary.moved.registrations).toBe(1);
  expect(result.summary.moved.invoice_lines).toBe(1);
  expect(result.summary.moved.person_credentials).toBe(1);
  expect(result.summary.moved.form_responses).toBe(1);
  expect(result.summary.moved.attendance).toBe(1);
  expect(result.summary.moved.emergency_contacts).toBe(1);
  expect(result.summary.moved.household_members).toBe(1);
  expect(result.summary.moved.household_members_deduplicated).toBe(1);

  const preservedSignature = await waivers.listSignatures(guardian, survivorId);
  expect(preservedSignature.items).toContainEqual(
    expect.objectContaining({
      id: signature.id,
      participantPersonId: mergedId,
      documentVersion: 1,
    }),
  );
  const historicalPdf = await waivers.signedPdf(guardian, signature.id);
  expect(Buffer.from(historicalPdf).subarray(0, 5).toString()).toBe('%PDF-');

  const state = await factories.scoped(staff, async (trx) => ({
    mergedPerson: await trx
      .selectFrom('people')
      .select(['status', 'merged_into_id'])
      .where('id', '=', mergedId)
      .executeTakeFirstOrThrow(),
    survivorRegistrations: await trx
      .selectFrom('registrations')
      .select('id')
      .where('org_id', '=', staff.orgId)
      .where('person_id', '=', survivorId)
      .execute(),
    mergedLinks: await trx
      .selectFrom('person_account_links')
      .select('revoked_at')
      .where('org_id', '=', staff.orgId)
      .where('person_id', '=', mergedId)
      .execute(),
    guardianLinks: await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', staff.orgId)
      .where('person_id', '=', survivorId)
      .where('account_id', '=', guardianId)
      .where('revoked_at', 'is', null)
      .execute(),
    mergeRow: await trx
      .selectFrom('person_merges')
      .select('id')
      .where('org_id', '=', staff.orgId)
      .where('survivor_id', '=', survivorId)
      .where('merged_id', '=', mergedId)
      .executeTakeFirstOrThrow(),
    audit: await trx
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', survivorId)
      .where('action', '=', 'person.merged')
      .execute(),
  }));
  expect(state.mergedPerson.status).toBe('merged');
  expect(state.mergedPerson.merged_into_id).toBe(survivorId);
  expect(state.survivorRegistrations).toHaveLength(1);
  expect(state.mergedLinks[0]?.revoked_at).not.toBeNull();
  expect(state.guardianLinks).toHaveLength(1);
  expect(state.mergeRow.id).toBe(result.id);
  expect(state.audit).toHaveLength(1);
});

it('blocks the merge when both people hold active registrations in one program', async () => {
  const factories = createTestFactories(database);
  const staff = await staffActor(factories);
  const merges = createMergesRepository(database);
  const survivorId = await factories.person(staff, {
    firstName: 'Alex',
    lastName: 'Duplicate',
    dateOfBirth: '2012-02-02',
  });
  const mergedId = await factories.person(staff, {
    firstName: 'Alexander',
    lastName: 'Duplicate',
    dateOfBirth: '2012-02-02',
  });
  const fixture = await factories.program(staff);
  const householdId = await factories.household(staff);
  await factories.registration(staff, fixture, survivorId, householdId);
  await factories.registration(staff, fixture, mergedId, householdId);
  await expect(
    merges.merge(staff.orgId, staff.accountId, survivorId, mergedId),
  ).rejects.toMatchObject({
    status: 409,
    details: { conflicts: [{ programId: fixture.programId }] },
  });
  const stillActive = await factories.scoped(staff, (trx) =>
    trx
      .selectFrom('people')
      .select('status')
      .where('id', '=', mergedId)
      .executeTakeFirstOrThrow(),
  );
  expect(stillActive.status).toBe('active');
  await expect(
    merges.merge(staff.orgId, staff.accountId, survivorId, survivorId),
  ).rejects.toMatchObject({ status: 400 });
});
