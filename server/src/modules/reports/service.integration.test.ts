import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { ReportError } from './query';
import {
  createSavedReport,
  exportReport,
  getSavedReport,
  listSavedReports,
  previewReport,
  updateSavedReport,
} from './service';

const orgA = randomUUID();
const orgB = randomUUID();
const ownerId = randomUUID();
const financeId = randomUUID();
const registrarId = randomUUID();
const complianceId = randomUUID();
const personId = randomUUID();
let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;

const context = (orgId: string, accountId: string): OrgContext => ({
  orgId,
  actor: { accountId },
});

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const [id, name] of [
      [ownerId, 'Report Owner'],
      [financeId, 'Report Finance'],
      [registrarId, 'Report Registrar'],
      [complianceId, 'Report Compliance'],
    ] as const) {
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [id, `${id}@example.invalid`, name, 'Tester', '1980-01-01'],
      );
    }
    for (const [id, slug] of [
      [orgA, `reports-${orgA.slice(0, 8)}`],
      [orgB, `reports-${orgB.slice(0, 8)}`],
    ] as const) {
      await admin.query(
        'INSERT INTO organizations(id,slug,name,kind,timezone,status) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, slug, 'Reports Test', 'club', 'UTC', 'active'],
      );
    }
    const actors = [
      [ownerId, 'owner'],
      [financeId, 'finance'],
      [registrarId, 'registrar'],
      [complianceId, 'compliance'],
    ] as const;
    for (const [accountId, role] of actors) {
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
        [randomUUID(), orgA, accountId, 'active'],
      );
      await admin.query(
        'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,$4,$5,false)',
        [randomUUID(), orgA, accountId, role, 'org'],
      );
    }
    await admin.query(
      'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
      [randomUUID(), orgB, financeId, 'active'],
    );
    await admin.query(
      'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,$4,$5,false)',
      [randomUUID(), orgB, financeId, 'finance', 'org'],
    );
    await admin.query(
      'INSERT INTO people(id,org_id,first_name,last_name,date_of_birth,email) VALUES ($1,$2,$3,$4,$5,$6)',
      [personId, orgA, 'Alex', 'Athlete', '2012-01-01', 'alex@example.invalid'],
    );
    await admin.query(
      'INSERT INTO medical_profiles(id,org_id,person_id,allergy_flags) VALUES ($1,$2,$3,$4)',
      [randomUUID(), orgA, personId, ['food allergy']],
    );
    await admin.query(
      "INSERT INTO people(id,org_id,first_name,last_name,date_of_birth) SELECT gen_random_uuid(), $1, 'Roster', 'Member ' || i::text, '2012-01-01'::date FROM generate_series(1,205) AS i",
      [orgA],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

const definition = {
  dataset: 'people',
  columns: ['first_name'],
  filters: [],
  groupBy: [],
  aggregates: [],
  sort: [],
} as const;

describe('report service', () => {
  it('hides restricted medical columns from registrars and audits compliance previews', async () => {
    await expect(
      previewReport(
        context(orgA, registrarId),
        {
          ...definition,
          columns: ['first_name', 'allergy_flags'],
          filters: [{ column: 'id', op: 'eq', value: personId }],
        },
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 403 });

    const restricted = await previewReport(
      context(orgA, complianceId),
      {
        ...definition,
        columns: ['first_name', 'allergy_flags'],
        filters: [{ column: 'id', op: 'eq', value: personId }],
      },
      withOrg,
    );
    expect(restricted.rows).toEqual([['Alex', ['food allergy']]]);

    await expect(
      withOrg(context(orgA, complianceId), async (trx) =>
        trx
          .selectFrom('audit_log')
          .select(['action', 'entity_type', 'changes'])
          .where('org_id', '=', orgA)
          .where('action', '=', 'restricted.read')
          .where('entity_type', '=', 'report_dataset')
          .executeTakeFirstOrThrow(),
      ),
    ).resolves.toMatchObject({
      changes: {
        allergy_flags: { tier: 'restricted', after: '[redacted]' },
      },
    });
  });

  it('requires step-up for sensitive exports and permits an eligible finance role', async () => {
    const sensitiveDefinition = {
      ...definition,
      columns: ['email'],
      filters: [{ column: 'id', op: 'eq', value: personId }],
    };
    await expect(
      exportReport(
        context(orgA, financeId),
        sensitiveDefinition,
        false,
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 401, code: 'REAUTH_REQUIRED' });

    const report = await exportReport(
      context(orgA, financeId),
      sensitiveDefinition,
      true,
      withOrg,
    );
    expect(report.rows).toEqual([['alex@example.invalid']]);
  });

  it('caps unsaved report previews at 200 rows and indicates truncation', async () => {
    const preview = await previewReport(
      context(orgA, ownerId),
      { ...definition, limit: 50_000 },
      withOrg,
    );

    expect(preview.rows).toHaveLength(200);
    expect(preview.truncated).toBe(true);
  });

  it('shares reports by role, limits edits to the author or administrators, and checks versions', async () => {
    const ownerContext = context(orgA, ownerId);
    const report = await createSavedReport(
      ownerContext,
      {
        name: 'Active people',
        definition,
        sharedRoles: ['finance'],
      },
      withOrg,
    );
    await expect(
      listSavedReports(context(orgA, financeId), withOrg),
    ).resolves.toMatchObject({
      items: [{ id: report.id, name: 'Active people' }],
    });
    await expect(
      getSavedReport(context(orgB, financeId), report.id, withOrg),
    ).rejects.toBeInstanceOf(ReportError);
    await expect(
      updateSavedReport(
        context(orgA, financeId),
        report.id,
        { name: 'Changed', expectedVersion: report.version },
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 403 });

    const updated = await updateSavedReport(
      ownerContext,
      report.id,
      { name: 'Active people this season', expectedVersion: report.version },
      withOrg,
    );
    expect(updated.version).toBe(report.version + 1);
    await expect(
      updateSavedReport(
        ownerContext,
        report.id,
        { name: 'Stale update', expectedVersion: report.version },
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
