import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { createImportsRepository } from '../src/modules/imports/repo';

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

const MAPPING = {
  firstName: 'First Name',
  lastName: 'Last Name',
  dateOfBirth: 'DOB',
  email: 'Email',
  phone: 'Phone',
  gender: 'Gender',
  householdName: 'Household',
};

const DATE_FORMATS = [
  (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  (y: number, m: number, d: number) => `${m}/${d}/${y}`,
  (y: number, m: number, d: number) => `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}-${y}`,
  (y: number, m: number, d: number) => `${y}/${m}/${d}`,
];

function buildCsv(rowCount: number): string {
  const lines = ['First Name,Last Name,DOB,Email,Phone,Gender,Household'];
  for (let index = 0; index < rowCount; index += 1) {
    const dob = DATE_FORMATS[index % DATE_FORMATS.length](
      2010 + (index % 8),
      1 + (index % 12),
      1 + (index % 28),
    );
    lines.push(
      `Bulk${index},Athlete${index},${dob},bulk${index}@example.org,415555${String(1000 + (index % 9000))},${index % 2 ? 'F' : 'M'},Household ${index % 50}`,
    );
  }
  return lines.join('\n');
}

it(
  'previews issues, commits a 2,000-row people import under 30 seconds and rolls back',
  { timeout: 120_000 },
  async () => {
    const factories = createTestFactories(database);
    const staff = await staffActor(factories);
    const imports = createImportsRepository(database);

    const duplicates = await Promise.all(
      ['dup-a', 'dup-b', 'dup-c'].map((key) =>
        factories.person(staff, {
          firstName: 'Existing',
          lastName: `Dup-${key}`,
          dateOfBirth: '2013-04-05',
        }),
      ),
    );
    await factories.scoped(staff, async (trx) => {
      for (const [index, personId] of duplicates.entries())
        await trx
          .updateTable('people')
          .set({ email: `existing-${index}@example.org` })
          .where('id', '=', personId)
          .execute();
    });

    const csv = [
      buildCsv(1992),
      'Existing,Dup-A,2013-04-05,existing-0@example.org,,M,',
      'Existing,Dup-B,04/05/2013,existing-1@example.org,,F,',
      'Existing,Dup-C,4-5-2013,existing-2@example.org,,M,',
      'NoFirst,,2013-01-01,no-first@example.org,,M,',
      ',NoLast,2013-01-01,no-last@example.org,,F,',
      'Bad,Email,2013-01-01,not-an-email,,M,',
      'Bad,Phone,2013-01-01,bad-phone@example.org,abc,F,',
      'Bad,Date,not-a-date,bad-date@example.org,,M,',
    ].join('\n');

    const preview = await imports.create(staff.orgId, staff.accountId, {
      kind: 'people',
      filename: 'roster.csv',
      content: csv,
      mapping: MAPPING,
      duplicateStrategy: 'skip',
    });
    expect(preview.batch.stats).toEqual({
      total: 2000,
      create: 1992,
      update: 0,
      skip: 3,
      invalid: 5,
    });
    const invalidRows = preview.rows.filter((row) => row.action === 'invalid');
    expect(invalidRows.map((row) => row.rowNumber)).toEqual([
      1996, 1997, 1998, 1999, 2000,
    ]);
    expect(invalidRows[0]?.issues[0]?.code).toBe('required');
    expect(invalidRows[2]?.issues[0]?.code).toBe('invalid_email');
    expect(invalidRows[3]?.issues[0]?.code).toBe('invalid_phone');
    expect(invalidRows[4]?.issues[0]?.code).toBe('invalid_date');
    const skipped = preview.rows.filter((row) => row.action === 'skip');
    expect(skipped.every((row) => row.issues[0]?.code === 'possible_duplicate')).toBe(
      true,
    );
    const secondRow = preview.rows[1]!;
    expect(
      (secondRow.normalized as { dateOfBirth: string }).dateOfBirth,
    ).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const started = Date.now();
    const committed = await imports.commit(
      staff.orgId,
      staff.accountId,
      preview.batch.id,
    );
    const elapsedMs = Date.now() - started;
    expect(committed.status).toBe('committed');
    expect(elapsedMs).toBeLessThan(30_000);

    const created = await factories.scoped(staff, async (trx) => ({
      people: await trx
        .selectFrom('people')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('org_id', '=', staff.orgId)
        .where('email', 'like', 'bulk%@example.org')
        .executeTakeFirstOrThrow(),
      members: await trx
        .selectFrom('household_members')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('org_id', '=', staff.orgId)
        .execute(),
      households: await trx
        .selectFrom('households')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('org_id', '=', staff.orgId)
        .execute(),
    }));
    expect(Number(created.people.n)).toBe(1992);
    expect(Number(created.members.n)).toBe(1992);
    expect(Number(created.households.n)).toBe(50);

    await expect(
      imports.commit(staff.orgId, staff.accountId, preview.batch.id),
    ).rejects.toMatchObject({ status: 409 });

    const rolled = await imports.rollback(
      staff.orgId,
      staff.accountId,
      preview.batch.id,
    );
    expect(rolled.status).toBe('rolled_back');
    const after = await factories.scoped(staff, async (trx) => ({
      people: await trx
        .selectFrom('people')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('org_id', '=', staff.orgId)
        .where('email', 'like', 'bulk%@example.org')
        .executeTakeFirstOrThrow(),
      members: await trx
        .selectFrom('household_members')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('org_id', '=', staff.orgId)
        .execute(),
      households: await trx
        .selectFrom('households')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('org_id', '=', staff.orgId)
        .execute(),
    }));
    expect(Number(after.people.n)).toBe(0);
    expect(Number(after.members.n)).toBe(0);
    expect(Number(after.households.n)).toBe(0);
  },
);

it('refuses to roll back a batch whose people were touched', async () => {
  const factories = createTestFactories(database);
  const staff = await staffActor(factories);
  const imports = createImportsRepository(database);
  const preview = await imports.create(staff.orgId, staff.accountId, {
    kind: 'people',
    filename: 'small.csv',
    content: [
      'First Name,Last Name,DOB,Email',
      'Touched,Player,2012-06-15,touched@example.org',
    ].join('\n'),
    mapping: MAPPING,
    duplicateStrategy: 'skip',
  });
  await imports.commit(staff.orgId, staff.accountId, preview.batch.id);
  const personId = await factories.scoped(staff, async (trx) =>
    trx
      .selectFrom('people')
      .select('id')
      .where('org_id', '=', staff.orgId)
      .where('email', '=', 'touched@example.org')
      .executeTakeFirstOrThrow(),
  );
  const fixture = await factories.program(staff);
  const householdId = await factories.household(staff);
  await factories.registration(staff, fixture, personId.id, householdId);
  await expect(
    imports.rollback(staff.orgId, staff.accountId, preview.batch.id),
  ).rejects.toMatchObject({ status: 409 });
});

it('requires staff and scopes to the tenant', async () => {
  const factories = createTestFactories(database);
  const staff = await staffActor(factories);
  const outsider = await factories.actor();
  const imports = createImportsRepository(database);
  await expect(
    imports.create(outsider.orgId, outsider.accountId, {
      kind: 'people',
      filename: 'x.csv',
      content: 'First Name,Last Name,DOB\nA,B,2012-01-01',
      mapping: MAPPING,
      duplicateStrategy: 'skip',
    }),
  ).rejects.toMatchObject({ status: 403 });
  const batch = await imports.create(staff.orgId, staff.accountId, {
    kind: 'people',
    filename: 'y.csv',
    content: 'First Name,Last Name,DOB\nA,B,2012-01-01',
    mapping: MAPPING,
    duplicateStrategy: 'skip',
  });
  await expect(
    imports.get(outsider.orgId, outsider.accountId, batch.batch.id),
  ).rejects.toMatchObject({ status: 403 });
});
