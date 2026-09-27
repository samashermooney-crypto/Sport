import { randomUUID } from 'node:crypto';

import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import {
  gradeFromGraduationYear,
  gradeLabel,
  schoolYearEndYear,
} from '@shared/sport/age';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';

import { createPeopleRepository, PeopleError } from './repo';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('scopes people, versions edits, archives instead of deleting, and audits writes', async () => {
  const withOrg = createWithOrg(database);
  async function actor() {
    const orgId = newId();
    const accountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `people-${randomUUID()}@example.invalid`,
        first_name: 'Test',
        last_name: 'Owner',
        date_of_birth: '1980-01-01',
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `people-${randomUUID().slice(0, 12)}`,
        name: 'People Test',
        kind: 'club',
        timezone: 'UTC',
      })
      .execute();
    const context = { orgId, actor: { accountId }, accountId };
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
  const owner = await actor();
  const outsider = await actor();
  const people = createPeopleRepository(database);
  const created = await people.create(owner.orgId, owner.accountId, {
    firstName: 'Alex',
    lastName: 'Rivera',
    preferredName: null,
    dateOfBirth: '2011-04-12',
    graduationYear: 2029,
    gender: 'female',
    email: 'alex@example.invalid',
    phoneE164: null,
    mediaConsent: 'unknown',
  });
  expect(created.version).toBe(1);
  const today = orgToday('UTC');
  const age = ageOnDate('2011-04-12', today);
  expect(created).toMatchObject({
    age,
    graduationYear: 2029,
    grade: gradeLabel(
      gradeFromGraduationYear(2029, schoolYearEndYear(today, '08-01')),
    ),
  });
  const matching = await people.list(owner.orgId, owner.accountId, {
    status: 'active',
    gender: 'female',
    minAge: age,
    maxAge: age,
    grade: gradeFromGraduationYear(2029, schoolYearEndYear(today, '08-01')),
    limit: 30,
  });
  expect(matching.items.map((person) => person.id)).toEqual([created.id]);
  expect(
    (
      await people.list(owner.orgId, owner.accountId, {
        status: 'active',
        gender: 'male',
        limit: 30,
      })
    ).items,
  ).toEqual([]);
  await expect(
    people.create(owner.orgId, owner.accountId, {
      firstName: 'Future',
      lastName: 'Child',
      preferredName: null,
      dateOfBirth: '2200-01-01',
      graduationYear: null,
      gender: 'unspecified',
      email: null,
      phoneE164: null,
      mediaConsent: 'unknown',
    }),
  ).rejects.toMatchObject({ status: 400 });
  const householdId = newId();
  const invoiceId = newId();
  await withOrg(owner, async (trx) => {
    await trx
      .insertInto('households')
      .values({
        id: householdId,
        org_id: owner.orgId,
        name: 'Rivera household',
      })
      .execute();
    await trx
      .insertInto('household_members')
      .values({
        id: newId(),
        org_id: owner.orgId,
        household_id: householdId,
        person_id: created.id,
        role: 'athlete',
      })
      .execute();
    await trx
      .insertInto('invoices')
      .values({
        id: invoiceId,
        org_id: owner.orgId,
        number: 1,
        account_id: owner.accountId,
        household_id: householdId,
        status: 'open',
        subtotal_cents: 500,
        total_cents: 500,
        source: 'staff',
        issued_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('invoice_lines')
      .values({
        id: newId(),
        org_id: owner.orgId,
        invoice_id: invoiceId,
        kind: 'team_fee',
        description: 'Team fee',
        amount_cents: 500,
        unit_amount_cents: 500,
        person_id: created.id,
      })
      .execute();
  });
  expect(
    (
      await people.list(owner.orgId, owner.accountId, {
        status: 'active',
        householdId,
        hasBalance: true,
        limit: 30,
      })
    ).items.map((person) => person.id),
  ).toEqual([created.id]);
  expect(
    (
      await people.list(owner.orgId, owner.accountId, {
        status: 'active',
        hasBalance: false,
        limit: 30,
      })
    ).items,
  ).toEqual([]);
  await withOrg(owner, (trx) =>
    trx
      .updateTable('household_members')
      .set({ removed_at: new Date() })
      .where('org_id', '=', owner.orgId)
      .where('household_id', '=', householdId)
      .execute()
      .then(() => undefined),
  );
  expect(
    (
      await people.list(owner.orgId, owner.accountId, {
        status: 'active',
        householdId,
        limit: 30,
      })
    ).items,
  ).toEqual([]);
  expect(
    (
      await people.list(owner.orgId, owner.accountId, {
        q: 'Rivera',
        status: 'active',
        limit: 30,
      })
    ).items.map((person) => person.id),
  ).toEqual([created.id]);
  await expect(
    people.get(owner.orgId, outsider.accountId, created.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    people.get(outsider.orgId, outsider.accountId, created.id),
  ).rejects.toMatchObject({ status: 404 });
  const updated = await people.update(
    owner.orgId,
    owner.accountId,
    created.id,
    {
      expectedVersion: 1,
      preferredName: 'Lex',
    },
  );
  expect(updated).toMatchObject({
    preferredName: 'Lex',
    gender: 'female',
    email: 'alex@example.invalid',
    version: 2,
  });
  await expect(
    people.update(owner.orgId, owner.accountId, created.id, {
      expectedVersion: 1,
      firstName: 'Stale',
    }),
  ).rejects.toBeInstanceOf(PeopleError);
  const archived = await people.archive(
    owner.orgId,
    owner.accountId,
    created.id,
    2,
  );
  expect(archived).toMatchObject({ status: 'archived', version: 3 });
  expect(
    (
      await people.list(owner.orgId, owner.accountId, {
        status: 'active',
        limit: 30,
      })
    ).items,
  ).toEqual([]);
  expect(
    (
      await people.list(owner.orgId, owner.accountId, {
        status: 'archived',
        limit: 30,
      })
    ).items,
  ).toHaveLength(1);
  const restored = await people.restore(
    owner.orgId,
    owner.accountId,
    created.id,
    3,
  );
  expect(restored).toMatchObject({ status: 'active', version: 4 });
  const evidence = await withOrg(owner, (trx) =>
    trx
      .selectFrom('audit_log')
      .select('action')
      .where('org_id', '=', owner.orgId)
      .where('entity_id', '=', created.id)
      .orderBy('created_at')
      .execute(),
  );
  expect(evidence.map((event) => event.action)).toEqual([
    'person.created',
    'person.updated',
    'person.archived',
    'person.restored',
  ]);
});
