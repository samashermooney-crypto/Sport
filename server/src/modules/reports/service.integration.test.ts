import { randomUUID } from 'node:crypto';

import { PDFDocument } from 'pdf-lib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { buildBoardSeasonReportPdf } from './board-report';
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
const priorOnlyPersonId = randomUUID();
const newPersonId = randomUUID();
const householdId = randomUUID();
const sportProfileId = randomUUID();
const priorSeasonId = randomUUID();
const currentSeasonId = randomUUID();
const priorProgramId = randomUUID();
const currentProgramId = randomUUID();
const priorDivisionId = randomUUID();
const currentDivisionId = randomUUID();
const priorOfferingId = randomUUID();
const currentOfferingId = randomUUID();
const evaluationEventId = randomUUID();
const evaluationGroupId = randomUUID();
const evaluationParticipantId = randomUUID();
const evaluationResultId = randomUUID();
const complianceCredentialTypeId = randomUUID();
const expiredCredentialId = randomUUID();
const todayCredentialId = randomUUID();
const nonExpiringCredentialId = randomUUID();
const pendingCredentialId = randomUUID();
const revokedCredentialId = randomUUID();
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
      "INSERT INTO people(id,org_id,first_name,last_name,date_of_birth) VALUES ($1,$2,'Prior','Only','2012-01-01'),($3,$2,'New','Athlete','2012-01-01')",
      [priorOnlyPersonId, orgA, newPersonId],
    );
    await admin.query(
      "INSERT INTO households(id,org_id,name) VALUES ($1,$2,'Cohort family')",
      [householdId, orgA],
    );
    await admin.query(
      "INSERT INTO sport_profiles(id,org_id,name,profile) VALUES ($1,$2,'Cohort sport','{}'::jsonb)",
      [sportProfileId, orgA],
    );
    await admin.query(
      "INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status) VALUES ($1,$3,'2024 cohort','2024-01-01','2024-12-31','completed'),($2,$3,'2025 cohort','2025-01-01','2025-12-31','completed')",
      [priorSeasonId, currentSeasonId, orgA],
    );
    await admin.query(
      "INSERT INTO programs(id,org_id,season_id,sport_profile_id,mode,name,slug,starts_on,ends_on) VALUES ($1,$3,$4,$6,'league','Prior cohort','prior-cohort','2024-01-01','2024-12-31'),($2,$3,$5,$6,'league','Current cohort','current-cohort','2025-01-01','2025-12-31')",
      [
        priorProgramId,
        currentProgramId,
        orgA,
        priorSeasonId,
        currentSeasonId,
        sportProfileId,
      ],
    );
    await admin.query(
      "INSERT INTO evaluation_events(id,org_id,tryout_program_id,target_program_id,name,status) VALUES ($1,$2,$3,$4,'Fall assessments','results')",
      [evaluationEventId, orgA, priorProgramId, currentProgramId],
    );
    await admin.query(
      "INSERT INTO evaluation_groups(id,org_id,evaluation_event_id,name) VALUES ($1,$2,$3,'U14')",
      [evaluationGroupId, orgA, evaluationEventId],
    );
    await admin.query(
      'INSERT INTO evaluation_participants(id,org_id,evaluation_event_id,person_id,evaluation_group_id,bib_number) VALUES ($1,$2,$3,$4,$5,12)',
      [
        evaluationParticipantId,
        orgA,
        evaluationEventId,
        personId,
        evaluationGroupId,
      ],
    );
    await admin.query(
      "INSERT INTO evaluation_results(id,org_id,evaluation_event_id,evaluation_participant_id,normalized_scores,composite,rank_in_group,evaluator_count,missing_criteria) VALUES ($1,$2,$3,$4,'{}'::jsonb,9.25,1,2,'{}')",
      [evaluationResultId, orgA, evaluationEventId, evaluationParticipantId],
    );
    await admin.query(
      "INSERT INTO divisions(id,org_id,program_id,name) VALUES ($1,$3,$4,'Prior division'),($2,$3,$5,'Current division')",
      [
        priorDivisionId,
        currentDivisionId,
        orgA,
        priorProgramId,
        currentProgramId,
      ],
    );
    await admin.query(
      "INSERT INTO registration_offerings(id,org_id,program_id,division_id,name,registrant_role,active) VALUES ($1,$3,$4,$6,'Prior offering','athlete',true),($2,$3,$5,$7,'Current offering','athlete',true)",
      [
        priorOfferingId,
        currentOfferingId,
        orgA,
        priorProgramId,
        currentProgramId,
        priorDivisionId,
        currentDivisionId,
      ],
    );
    await admin.query(
      "INSERT INTO registrations(id,org_id,program_id,division_id,offering_id,person_id,household_id,registered_by_account_id,source,status) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'staff','confirmed'),(gen_random_uuid(),$1,$2,$3,$4,$8,$6,$7,'staff','confirmed'),(gen_random_uuid(),$1,$9,$10,$11,$5,$6,$7,'staff','confirmed'),(gen_random_uuid(),$1,$9,$10,$11,$12,$6,$7,'staff','confirmed')",
      [
        orgA,
        priorProgramId,
        priorDivisionId,
        priorOfferingId,
        personId,
        householdId,
        ownerId,
        priorOnlyPersonId,
        currentProgramId,
        currentDivisionId,
        currentOfferingId,
        newPersonId,
      ],
    );
    await admin.query(
      'INSERT INTO medical_profiles(id,org_id,person_id,allergy_flags) VALUES ($1,$2,$3,$4)',
      [randomUUID(), orgA, personId, ['food allergy']],
    );
    await admin.query(
      "INSERT INTO people(id,org_id,first_name,last_name,date_of_birth) SELECT gen_random_uuid(), $1, 'Roster', 'Member ' || i::text, '2012-01-01'::date FROM generate_series(1,205) AS i",
      [orgA],
    );
    await admin.query(
      `INSERT INTO credential_types
        (id,org_id,key,name,verification,validity,applies_to)
       VALUES ($1,$2,'report_compliance','Report compliance','manual_staff','{"never":true}'::jsonb,'{}'::jsonb)`,
      [complianceCredentialTypeId, orgA],
    );
    await admin.query(
      `INSERT INTO person_credentials
        (id,org_id,person_id,credential_type_id,status,expires_on,verified_by,verified_at)
       VALUES
        ($1,$2,$3,$4,'verified',CURRENT_DATE - 1,$5,now()),
        ($6,$2,$3,$4,'verified',CURRENT_DATE,$5,now()),
        ($7,$2,$3,$4,'verified',NULL,$5,now()),
        ($8,$2,$3,$4,'pending_review',NULL,NULL,NULL),
        ($9,$2,$3,$4,'revoked',NULL,NULL,NULL)`,
      [
        expiredCredentialId,
        orgA,
        personId,
        complianceCredentialTypeId,
        ownerId,
        todayCredentialId,
        nonExpiringCredentialId,
        pendingCredentialId,
        revokedCredentialId,
      ],
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
  it('treats an expired verified credential as needing attention before the expiry sweep', async () => {
    const preview = await previewReport(
      context(orgA, complianceId),
      {
        dataset: 'credentials',
        columns: ['compliance_status'],
        filters: [{ column: 'status', op: 'ne', value: 'revoked' }],
        groupBy: ['compliance_status'],
        aggregates: [{ fn: 'count', column: 'id' }],
        sort: [{ column: 'compliance_status', direction: 'asc' }],
      },
      withOrg,
    );

    expect(preview.rows).toEqual([
      ['expired', 1],
      ['pending_review', 1],
      ['verified', 2],
    ]);
  });

  it('assembles a one-page board PDF and preserves the financial step-up gate', async () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    const registrarPdf = await buildBoardSeasonReportPdf(
      context(orgA, registrarId),
      { stepUpAuthenticated: false, now },
      withOrg,
    );
    const registrarDocument = await PDFDocument.load(registrarPdf);

    expect(registrarDocument.getTitle()).toBe('Board season summary');
    expect(registrarDocument.getPageCount()).toBe(1);

    await expect(
      buildBoardSeasonReportPdf(
        context(orgA, financeId),
        { stepUpAuthenticated: false, now },
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 401, code: 'REAUTH_REQUIRED' });

    const financePdf = await buildBoardSeasonReportPdf(
      context(orgA, financeId),
      { stepUpAuthenticated: true, now },
      withOrg,
    );
    const financeDocument = await PDFDocument.load(financePdf);
    expect(financeDocument.getPageCount()).toBe(1);
  });

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

  it('groups registration pace into weekly buckets', async () => {
    const preview = await previewReport(
      context(orgA, registrarId),
      {
        dataset: 'registrations',
        columns: ['id'],
        filters: [],
        groupBy: ['created_at'],
        timeGrain: 'week',
        aggregates: [{ fn: 'count', column: 'id' }],
        sort: [{ column: 'created_at', direction: 'asc' }],
        limit: 200,
      },
      withOrg,
    );

    expect(preview.columns).toMatchObject([
      { key: 'created_at', type: 'datetime' },
      { key: 'count_id', type: 'number' },
    ]);
    expect(preview.rows.length).toBeGreaterThan(0);
  });

  it('calculates year-over-year retention from unique confirmed participants', async () => {
    const cohorts = await previewReport(
      context(orgA, registrarId),
      {
        dataset: 'retention_cohorts',
        columns: [
          'current_year',
          'previous_year',
          'previous_participants',
          'retained_participants',
          'retention_rate_percent',
        ],
        sort: [{ column: 'current_year', direction: 'asc' }],
      },
      withOrg,
    );

    expect(cohorts.rows).toEqual([[2025, 2024, 2, 1, 50]]);
  });

  it('reports scored evaluation results only within the organization', async () => {
    const results = await previewReport(
      context(orgA, ownerId),
      {
        dataset: 'evaluation_results',
        columns: [
          'event_name',
          'program_name',
          'group_name',
          'participant_name',
          'rank_in_group',
          'composite_score',
        ],
      },
      withOrg,
    );

    expect(results.rows).toHaveLength(1);
    expect(results.rows[0]?.slice(0, 5)).toEqual([
      'Fall assessments',
      'Current cohort',
      'U14',
      'Alex Athlete',
      1,
    ]);
    expect(Number(results.rows[0]?.[5])).toBe(9.25);
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
