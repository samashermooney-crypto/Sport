import { randomBytes, randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { ManualBackgroundCheckProvider } from '../../integrations/background-check/provider';
import { FakeEmailSender } from '../../integrations/email/sender';
import { MemoryStorage } from '../../integrations/storage/storage';
import { parseEncryptionKeys } from '../../lib/crypto';
import { FilesService } from '../../modules/files/service';
import {
  createDisciplineRecord,
  updateDisciplineRecord,
  assertNotSuspendedForLineup,
} from '../discipline/service';
import {
  reportInjury,
  listInjuries,
  listClearanceReviews,
  reviewClearance,
  submitClearance,
  reportIncident,
  listIncidents,
  readIncident,
} from '../safety/service';

import { createCard, verifyCard } from './cards';
import {
  assertEligibleForRole,
  evaluateRoleEligibility,
  RoleEligibilityError,
} from './policy';
import {
  adjudicateBackgroundCheck,
  beginBackgroundCheck,
  createComplianceOverride,
  listBackgroundCheckDisputes,
  listOwnBackgroundChecks,
  listPersonCredentials,
  listCredentialReviewQueue,
  listCredentialTypes,
  processCredentialExpiry,
  recordManualResult,
  resendAdverseActionNotice,
  resolveBackgroundCheckDispute,
  reviewCredential,
  saveBackgroundSettings,
  saveRequirement,
  sendPreAdverseNotice,
  submitBackgroundCheckDispute,
  submitCredential,
  updateCredentialSubmission,
  updateCredentialType,
  revokePersonCredential,
} from './service';

const orgA = randomUUID();
const orgB = randomUUID();
const accountA = randomUUID();
const guardianA = randomUUID();
const accountB = randomUUID();
const personA = randomUUID();
const personB = randomUUID();
const underagePersonA = randomUUID();
const credentialTypeId = randomUUID();
const seasonId = randomUUID();
const sportProfileId = randomUUID();
const programId = randomUUID();
const divisionId = randomUUID();
const teamId = randomUUID();
const teamSeasonId = randomUUID();
const rosterEntryId = randomUUID();
const teamStaffId = randomUUID();
const ownerContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: accountA },
};
const familyContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: guardianA },
};
const encryption = parseEncryptionKeys(
  JSON.stringify({ test: randomBytes(32).toString('base64') }),
  'test',
);
const email = new FakeEmailSender();
const manualProvider = new ManualBackgroundCheckProvider();
let clockNow = new Date('2026-09-28T18:00:00.000Z');
let database: Kysely<DB>;
let credentialId: string;
let injuryOneId: string;
let injuryTwoId: string;
let incidentId: string;
let orderId: string;
let disputeId: string;

const dependencies = () => ({
  database,
  encryption,
  email,
  providers: { manual: manualProvider },
  checkrEnabled: false,
  clock: () => clockNow,
  appUrl: 'https://athlentry.test',
});

const safetyDependencies = () => ({
  database,
  encryption,
  clock: () => clockNow,
});
const withOrg = () => createWithOrg(database);

async function expectRoleIneligible(
  personId: string,
  code: string,
  now = new Date(),
): Promise<void> {
  try {
    await assertEligibleForRole(
      database,
      ownerContext,
      {
        personId,
        role: 'head_coach',
      },
      now,
    );
    throw new Error(
      'Expected the role eligibility check to reject this person',
    );
  } catch (error) {
    expect(error).toBeInstanceOf(RoleEligibilityError);
    if (!(error instanceof RoleEligibilityError)) throw error;
    expect(error.result.eligible).toBe(false);
    expect(error.result.missing.some((item) => item.code === code)).toBe(true);
  }
}

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO organizations (id, slug, name, kind, timezone, status)
       VALUES ($1, $2, 'Safety Test A', 'club', 'America/Chicago', 'active'),
              ($3, $4, 'Safety Test B', 'club', 'America/Chicago', 'active')`,
      [
        orgA,
        `safety-a-${orgA.slice(0, 8)}`,
        orgB,
        `safety-b-${orgB.slice(0, 8)}`,
      ],
    );
    await admin.query(
      `INSERT INTO accounts (id, email, first_name, last_name, date_of_birth)
       VALUES ($1, 'safety-owner@example.invalid', 'Morgan', 'Coach', '1988-01-01'),
              ($2, 'safety-guardian@example.invalid', 'Taylor', 'Guardian', '1985-01-01'),
              ($3, 'safety-other@example.invalid', 'Casey', 'Other', '1990-01-01')`,
      [accountA, guardianA, accountB],
    );
    await admin.query(
      `INSERT INTO people (id, org_id, first_name, last_name, date_of_birth)
       VALUES ($1, $2, 'Morgan', 'Coach', '1988-01-01'),
              ($3, $4, 'Casey', 'Other', '1990-01-01'),
              ($5, $2, 'Jamie', 'Youth', '2015-03-01')`,
      [personA, orgA, personB, orgB, underagePersonA],
    );
    await admin.query(
      `INSERT INTO person_account_links (id, org_id, person_id, account_id, relationship, verified_at)
       VALUES ($1, $2, $3, $4, 'self', now()),
              ($5, $2, $3, $6, 'guardian', now()),
              ($7, $8, $9, $10, 'self', now()),
              ($11, $2, $12, $6, 'guardian', now())`,
      [
        randomUUID(),
        orgA,
        personA,
        accountA,
        randomUUID(),
        guardianA,
        randomUUID(),
        orgB,
        personB,
        accountB,
        randomUUID(),
        underagePersonA,
      ],
    );
    const membershipId = randomUUID();
    await admin.query(
      `INSERT INTO org_memberships (id, org_id, account_id, status, joined_at)
       VALUES ($1, $2, $3, 'active', now())`,
      [membershipId, orgA, accountA],
    );
    await admin.query(
      `INSERT INTO role_assignments (id, org_id, account_id, role, scope_type, granted_by, pending_mfa)
       VALUES ($1, $2, $3, 'owner', 'org', $3, false)`,
      [randomUUID(), orgA, accountA],
    );
    await admin.query(
      `INSERT INTO credential_types
       (id, org_id, key, name, verification, validity, applies_to, blocks_activation, renewal_reminder_days)
       VALUES ($1, $2, 'coach_safesport', 'SafeSport training', 'document_upload',
               '{"months":1}'::jsonb, '{"roles":["head_coach"],"minimumAge":18}'::jsonb,
               true, ARRAY[30,14,3])`,
      [credentialTypeId, orgA],
    );
    await admin.query(
      `INSERT INTO sport_profiles (id, org_id, name, profile)
       VALUES ($1, $2, 'Test Sport', '{}'::jsonb)`,
      [sportProfileId, orgA],
    );
    await admin.query(
      `INSERT INTO seasons (id, org_id, name, starts_on, ends_on, status)
       VALUES ($1, $2, 'Safety Season', '2026-01-01', '2027-12-31', 'active')`,
      [seasonId, orgA],
    );
    await admin.query(
      `INSERT INTO programs (id, org_id, season_id, sport_profile_id, mode, name, slug,
                             status, visibility, starts_on, ends_on)
       VALUES ($1, $2, $3, $4, 'league', 'Safety League', 'safety-league',
               'in_progress', 'private', '2026-01-01', '2027-12-31')`,
      [programId, orgA, seasonId, sportProfileId],
    );
    await admin.query(
      `INSERT INTO divisions (id, org_id, program_id, name)
       VALUES ($1, $2, $3, 'Open')`,
      [divisionId, orgA, programId],
    );
    await admin.query(
      `INSERT INTO teams (id, org_id, name, sport_profile_id)
       VALUES ($1, $2, 'Safety Hawks', $3)`,
      [teamId, orgA, sportProfileId],
    );
    await admin.query(
      `INSERT INTO team_seasons (id, org_id, team_id, program_id, division_id, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [teamSeasonId, orgA, teamId, programId, divisionId],
    );
    await admin.query(
      `INSERT INTO roster_entries (id, org_id, team_season_id, person_id, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [rosterEntryId, orgA, teamSeasonId, personA],
    );
    await admin.query(
      `INSERT INTO team_staff (id, org_id, team_season_id, person_id, role, status, added_by)
       VALUES ($1, $2, $3, $4, 'head_coach', 'pending_compliance', $5)`,
      [teamStaffId, orgA, teamSeasonId, personA, accountA],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  await saveRequirement(database, ownerContext, {
    role: 'head_coach',
    credentialTypeId,
    scopeType: 'org',
    scopeId: null,
    minimumAge: 18,
    active: true,
  });
});

afterAll(async () => {
  await database.destroy();
});

describe('Phase 7 safety and compliance integration', () => {
  it('gates and activates credentialed staff, audits Restricted reads, and demotes on expiry', async () => {
    await expectRoleIneligible(personA, 'CREDENTIAL_MISSING');

    const updatedType = await updateCredentialType(database, ownerContext, {
      id: credentialTypeId,
      name: 'SafeSport training',
      description: 'Current training certificate',
      validity: { months: 1 },
      blocksActivation: true,
      renewalReminderDays: [30, 14, 3],
      active: true,
      version: 1,
    });
    expect(updatedType).toMatchObject({ id: credentialTypeId, version: 2 });
    await expect(
      updateCredentialType(database, ownerContext, {
        id: credentialTypeId,
        name: 'Stale edit',
        description: null,
        validity: { months: 1 },
        blocksActivation: true,
        renewalReminderDays: [30, 14, 3],
        active: true,
        version: 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(await listCredentialTypes(database, ownerContext)).toContainEqual(
      expect.objectContaining({
        id: credentialTypeId,
        description: 'Current training certificate',
        version: 2,
      }),
    );

    const submitted = await submitCredential(dependencies(), ownerContext, {
      personId: personA,
      credentialTypeId,
      identifier: 'SAFE-TRAINING-90210',
      issuedOn: '2026-09-01',
    });
    credentialId = submitted.id;
    const firstCredentialId = submitted.id;
    expect(submitted.identifierHint).toBe('••••0210');
    const correction = await updateCredentialSubmission(
      dependencies(),
      ownerContext,
      {
        credentialId,
        identifier: 'SAFE-TRAINING-5678',
        issuedOn: '2026-09-01',
        expiresOn: null,
        fileId: null,
        version: 1,
      },
    );
    expect(correction.version).toBe(2);
    await expect(
      updateCredentialSubmission(dependencies(), ownerContext, {
        credentialId,
        issuedOn: '2026-09-01',
        expiresOn: null,
        fileId: null,
        version: 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(
      await listPersonCredentials(database, ownerContext, personA),
    ).toMatchObject([
      {
        id: credentialId,
        status: 'pending_review',
        identifierHint: '••••5678',
      },
    ]);
    expect(
      await listCredentialReviewQueue(database, ownerContext),
    ).toMatchObject([
      { id: credentialId, firstName: 'Morgan', status: 'pending_review' },
    ]);
    const raw = await withOrg()(ownerContext, (trx) =>
      trx
        .selectFrom('person_credentials')
        .select('identifier_enc')
        .where('id', '=', credentialId)
        .executeTakeFirstOrThrow(),
    );
    expect(Buffer.from(raw.identifier_enc ?? []).toString()).not.toContain(
      'SAFE-TRAINING-90210',
    );
    const review = await reviewCredential(dependencies(), ownerContext, {
      credentialId,
      decision: 'approve',
      version: 2,
    });
    expect(review).toMatchObject({
      status: 'verified',
      expiresOn: '2026-10-01',
      version: 3,
    });
    expect(
      await assertEligibleForRole(database, ownerContext, {
        personId: personA,
        role: 'head_coach',
      }),
    ).toMatchObject({ eligible: true, missing: [], overridden: false });
    const staff = await withOrg()(ownerContext, (trx) =>
      trx
        .selectFrom('team_staff')
        .select('status')
        .where('id', '=', teamStaffId)
        .executeTakeFirstOrThrow(),
    );
    expect(staff.status).toBe('active');
    const audit = await withOrg()(ownerContext, (trx) =>
      trx
        .selectFrom('audit_log')
        .select(['action', 'entity_id'])
        .where('entity_id', '=', firstCredentialId)
        .execute(),
    );
    expect(audit.map((row) => row.action)).toContain('restricted.read');

    const revoked = await revokePersonCredential(database, ownerContext, {
      credentialId: firstCredentialId,
      reason: 'Replacing a credential after correcting the source document.',
      version: 3,
    });
    expect(revoked).toMatchObject({ status: 'revoked', version: 4 });
    expect(
      await withOrg()(ownerContext, (trx) =>
        trx
          .selectFrom('team_staff')
          .select('status')
          .where('id', '=', teamStaffId)
          .executeTakeFirstOrThrow(),
      ),
    ).toMatchObject({ status: 'pending_compliance' });
    const replacement = await submitCredential(dependencies(), ownerContext, {
      personId: personA,
      credentialTypeId,
      issuedOn: '2026-09-01',
    });
    credentialId = replacement.id;
    await reviewCredential(dependencies(), ownerContext, {
      credentialId,
      decision: 'approve',
      version: 1,
    });
    expect(
      await withOrg()(ownerContext, (trx) =>
        trx
          .selectFrom('team_staff')
          .select('status')
          .where('id', '=', teamStaffId)
          .executeTakeFirstOrThrow(),
      ),
    ).toMatchObject({ status: 'active' });

    const isolated = await listPersonCredentials(
      database,
      ownerContext,
      personB,
    ).catch((error: unknown) => error);
    expect(isolated).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await processCredentialExpiry(dependencies(), ownerContext)).toEqual(
      { reminded: 1, expired: 0, demoted: 0 },
    );
    clockNow = new Date('2026-10-02T18:00:00.000Z');
    expect(await processCredentialExpiry(dependencies(), ownerContext)).toEqual(
      { reminded: 0, expired: 1, demoted: 1 },
    );
    await expectRoleIneligible(personA, 'CREDENTIAL_UNVERIFIED', clockNow);
    const demoted = await withOrg()(ownerContext, (trx) =>
      trx
        .selectFrom('team_staff')
        .select('status')
        .where('id', '=', teamStaffId)
        .executeTakeFirstOrThrow(),
    );
    expect(demoted.status).toBe('pending_compliance');
  });

  it('applies bounded overrides and never overrides the minimum age', async () => {
    clockNow = new Date('2026-10-02T18:00:00.000Z');
    await withOrg()(ownerContext, (trx) =>
      trx
        .updateTable('person_credentials')
        .set({ status: 'expired' })
        .where('id', '=', credentialId)
        .execute(),
    );
    const override = await createComplianceOverride(
      dependencies(),
      ownerContext,
      {
        personId: personA,
        role: 'head_coach',
        scopeType: 'org',
        scopeId: null,
        reason: 'Short administrative grace while renewal completes.',
        expiresOn: '2026-10-16',
      },
    );
    expect(override.expiresOn).toBe('2026-10-16');
    const eligibility = await withOrg()(ownerContext, (trx) =>
      evaluateRoleEligibility(
        trx,
        ownerContext,
        { personId: personA, role: 'head_coach' },
        clockNow,
      ),
    );
    expect(eligibility).toMatchObject({ eligible: true, overridden: true });
    await expect(
      createComplianceOverride(dependencies(), ownerContext, {
        personId: personA,
        role: 'head_coach',
        scopeType: 'org',
        scopeId: null,
        reason: 'Too long.',
        expiresOn: '2026-10-17',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      createComplianceOverride(dependencies(), ownerContext, {
        personId: underagePersonA,
        role: 'head_coach',
        scopeType: 'org',
        scopeId: null,
        reason: 'Age cannot be waived.',
        expiresOn: '2026-10-10',
      }),
    ).rejects.toMatchObject({ code: 'UNDER_MINIMUM_AGE' });
  });

  it('lets a linked guardian revoke a credential without deleting its audit history', async () => {
    const files = new FilesService(
      new MemoryStorage(),
      {
        canUpload: () => Promise.resolve(true),
        canDownload: () => Promise.resolve(true),
      },
      undefined,
      withOrg(),
    );
    const bytes = new TextEncoder().encode('%PDF-1.7\n');
    const pendingFile = await files.beginUpload({
      context: familyContext,
      purpose: 'document',
      mime: 'application/pdf',
      bytes: bytes.byteLength,
      ownerType: 'person_credential',
      ownerId: underagePersonA,
      sensitivity: 'restricted',
    });
    await files.uploadLocalBytes(familyContext, pendingFile.fileId, bytes);
    await files.completeUpload(familyContext, pendingFile.fileId);
    const submitted = await submitCredential(dependencies(), familyContext, {
      personId: underagePersonA,
      credentialTypeId,
      fileId: pendingFile.fileId,
    });
    await expect(
      submitCredential(dependencies(), ownerContext, {
        personId: personA,
        credentialTypeId,
        fileId: pendingFile.fileId,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'FILE_INVALID' });
    const correction = await updateCredentialSubmission(
      dependencies(),
      familyContext,
      {
        credentialId: submitted.id,
        identifier: 'YOUTH-TRAINING-1001',
        issuedOn: null,
        expiresOn: null,
        fileId: pendingFile.fileId,
        version: 1,
      },
    );
    expect(correction.version).toBe(2);
    const revoked = await revokePersonCredential(database, familyContext, {
      credentialId: submitted.id,
      reason: 'Guardian asked to withdraw this submitted credential.',
      version: 2,
    });
    expect(revoked).toMatchObject({
      id: submitted.id,
      status: 'revoked',
      version: 3,
    });
    expect(
      await listPersonCredentials(database, familyContext, underagePersonA),
    ).toContainEqual(
      expect.objectContaining({ id: submitted.id, status: 'revoked' }),
    );
    expect(
      await withOrg()(familyContext, (trx) =>
        trx
          .selectFrom('audit_log')
          .select('action')
          .where('entity_id', '=', submitted.id)
          .execute(),
      ),
    ).toContainEqual(
      expect.objectContaining({ action: 'person_credential.revoked' }),
    );
  });

  it('holds and restores every roster after multiple concussions, restricts SafeSport reports, verifies minimal QR cards, and blocks suspended lineups', async () => {
    injuryOneId = (
      await reportInjury(safetyDependencies(), familyContext, {
        personId: personA,
        occurredAt: '2026-09-27T18:00:00.000Z',
        suspectedConcussion: true,
        description: 'Possible concussion during practice.',
      })
    ).id;
    injuryTwoId = (
      await reportInjury(safetyDependencies(), familyContext, {
        personId: personA,
        occurredAt: '2026-09-28T18:00:00.000Z',
        suspectedConcussion: true,
        description: 'Second concussion report for hold coverage.',
      })
    ).id;
    let roster = await withOrg()(ownerContext, (trx) =>
      trx
        .selectFrom('roster_entries')
        .select('status')
        .where('id', '=', rosterEntryId)
        .executeTakeFirstOrThrow(),
    );
    expect(roster.status).toBe('injured');
    const familyInjuries = await listInjuries(
      safetyDependencies(),
      familyContext,
      personA,
    );
    expect(familyInjuries).toHaveLength(2);
    const injuryAudit = await withOrg()(familyContext, (trx) =>
      trx
        .selectFrom('audit_log')
        .select('action')
        .where('entity_id', 'in', [injuryOneId, injuryTwoId])
        .execute(),
    );
    expect(
      injuryAudit.filter((row) => row.action === 'restricted.read'),
    ).toHaveLength(2);
    expect(
      await withOrg()(familyContext, (trx) =>
        trx
          .selectFrom('notifications')
          .select('type')
          .where('account_id', '=', guardianA)
          .where('type', '=', 'safety.injury_reported')
          .execute(),
      ),
    ).toHaveLength(2);

    const card = await createCard(
      {
        database,
        encryption,
        clock: () => clockNow,
        appUrl: 'https://athlentry.test',
      },
      ownerContext,
      {
        personId: personA,
        cardKind: 'player',
        programId,
        seasonId: null,
        cardNumber: 'HAWK-42',
        validUntil: '2027-12-31',
        photoFileId: null,
      },
    );
    const publicCard = await verifyCard(
      database,
      card.token,
      encryption,
      clockNow,
    );
    expect(publicCard).toMatchObject({
      cardNumber: 'HAWK-42',
      personName: 'Morgan Coach',
      teamName: 'Safety Hawks',
      photoAvailable: false,
    });
    expect(publicCard).not.toHaveProperty('dateOfBirth');
    expect(publicCard).not.toHaveProperty('phone');
    expect(publicCard).not.toHaveProperty('medical');

    const concern = await reportIncident(safetyDependencies(), familyContext, {
      category: 'safesport_concern',
      occurredAt: clockNow.toISOString(),
      peopleInvolved: [personA],
      narrative: 'A family member reported a restricted SafeSport concern.',
    });
    incidentId = concern.id;
    expect(concern.restricted).toBe(true);
    expect(
      await listIncidents(database, familyContext, {
        canReview: false,
        canReadRestricted: false,
      }),
    ).toEqual([]);
    await expect(
      readIncident(safetyDependencies(), familyContext, incidentId, {
        canReview: false,
        canReadRestricted: false,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(
      readIncident(safetyDependencies(), ownerContext, incidentId, {
        canReview: true,
        canReadRestricted: true,
      }),
    ).resolves.toMatchObject({
      narrative: 'A family member reported a restricted SafeSport concern.',
      restricted: true,
    });
    expect(
      await listIncidents(database, ownerContext, {
        canReview: true,
        canReadRestricted: true,
      }),
    ).toContainEqual(
      expect.objectContaining({ id: incidentId, restricted: true }),
    );
    const incidentAudit = await withOrg()(ownerContext, (trx) =>
      trx
        .selectFrom('audit_log')
        .select('action')
        .where('entity_id', '=', incidentId)
        .execute(),
    );
    expect(
      incidentAudit.filter((row) => row.action === 'restricted.read').length,
    ).toBeGreaterThanOrEqual(2);

    const files = new FilesService(
      new MemoryStorage(),
      {
        canUpload: () => Promise.resolve(true),
        canDownload: () => Promise.resolve(true),
      },
      undefined,
      withOrg(),
    );
    const submitAndApprove = async (injuryReportId: string) => {
      const bytes = new TextEncoder().encode('%PDF-1.7\n');
      const pending = await files.beginUpload({
        context: familyContext,
        purpose: 'document',
        mime: 'application/pdf',
        bytes: bytes.byteLength,
        ownerType: 'return_to_play_clearance',
        ownerId: injuryReportId,
        sensitivity: 'restricted',
      });
      await files.uploadLocalBytes(familyContext, pending.fileId, bytes);
      await files.completeUpload(familyContext, pending.fileId);
      const clearance = await submitClearance(
        safetyDependencies(),
        familyContext,
        {
          injuryReportId,
          fileId: pending.fileId,
          providerName: 'Dr. Rowan Lee',
          clearedOn: '2026-09-29',
        },
      );
      expect(await listClearanceReviews(database, ownerContext)).toContainEqual(
        expect.objectContaining({
          id: clearance.id,
          reviewStatus: 'pending_review',
        }),
      );
      return reviewClearance(database, ownerContext, {
        clearanceId: clearance.id,
        decision: 'approve',
        version: 1,
      });
    };
    await submitAndApprove(injuryOneId);
    roster = await withOrg()(ownerContext, (trx) =>
      trx
        .selectFrom('roster_entries')
        .select('status')
        .where('id', '=', rosterEntryId)
        .executeTakeFirstOrThrow(),
    );
    expect(roster.status).toBe('injured');
    await submitAndApprove(injuryTwoId);
    roster = await withOrg()(ownerContext, (trx) =>
      trx
        .selectFrom('roster_entries')
        .select('status')
        .where('id', '=', rosterEntryId)
        .executeTakeFirstOrThrow(),
    );
    expect(roster.status).toBe('active');

    const suspension = await createDisciplineRecord(database, ownerContext, {
      personId: personA,
      teamSeasonId,
      type: 'suspension',
      description: 'Two game suspension.',
      suspensionGames: 2,
    });
    await expect(
      withOrg()(ownerContext, (trx) =>
        assertNotSuspendedForLineup(
          trx,
          ownerContext,
          personA,
          teamSeasonId,
          clockNow,
        ),
      ),
    ).rejects.toMatchObject({ code: 'DISCIPLINE_SUSPENSION_ACTIVE' });
    expect(
      await updateDisciplineRecord(database, ownerContext, {
        recordId: suspension.id,
        action: 'serve_games',
        games: 2,
        version: suspension.version,
      }),
    ).toMatchObject({ status: 'served', gamesServed: 2 });
    await expect(
      withOrg()(ownerContext, (trx) =>
        assertNotSuspendedForLineup(
          trx,
          ownerContext,
          personA,
          teamSeasonId,
          clockNow,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('runs the manual FCRA notice and dispute timeline using preview email only', async () => {
    await saveBackgroundSettings(database, ownerContext, false, {
      providerMode: 'manual',
      volunteerPaysFee: false,
      package: 'basic',
      disclosureVersion: '2026-01',
      disclosureText: 'Standalone background-check disclosure.',
      authorizationVersion: '2026-01',
      authorizationText: 'I authorize the background check.',
      preAdverseNoticeText: 'Pre-adverse decision notice.',
      rightsSummaryText: 'A copy of your rights is available here.',
      adverseNoticeText: 'Final adverse decision notice.',
      fcraHolidays: [],
    });
    const started = await beginBackgroundCheck(
      dependencies(),
      ownerContext,
      {
        personId: personA,
        disclosureVersion: '2026-01',
        authorizationVersion: '2026-01',
      },
      { ip: '192.0.2.10', userAgent: 'Track F integration fixture' },
    );
    orderId = started.id;
    const consent = await withOrg()(ownerContext, (trx) =>
      trx
        .selectFrom('background_check_orders')
        .select([
          'consent_ip',
          'consent_user_agent',
          'disclosure_text',
          'authorization_text',
        ])
        .where('id', '=', orderId)
        .executeTakeFirstOrThrow(),
    );
    expect(consent).toMatchObject({
      consent_ip: '192.0.2.10',
      consent_user_agent: 'Track F integration fixture',
    });
    let check = (await listOwnBackgroundChecks(database, ownerContext))[0];
    expect(check).toMatchObject({
      id: orderId,
      status: 'invited',
      adjudication: 'pending',
    });
    const result = await recordManualResult(dependencies(), ownerContext, {
      orderId,
      status: 'consider',
      resultSummary: 'consider',
      details: 'Sensitive report details stay encrypted.',
      version: check?.version ?? 0,
    });
    check = (await listOwnBackgroundChecks(database, ownerContext))[0];
    expect(result).toMatchObject({
      status: 'consider',
      resultSummary: 'consider',
    });
    const notice = await sendPreAdverseNotice(
      dependencies(),
      ownerContext,
      orderId,
    );
    expect(notice.delivered).toBe(true);
    expect(email.messages).toHaveLength(1);
    expect(email.messages[0]?.idempotencyKey).toBe(
      `fcra-pre-adverse:${orderId}`,
    );
    const submitted = await submitBackgroundCheckDispute(
      dependencies(),
      ownerContext,
      orderId,
      'The report includes another person with a similar name.',
    );
    disputeId = submitted.id;
    expect(
      await listBackgroundCheckDisputes(dependencies(), ownerContext),
    ).toMatchObject([
      {
        id: disputeId,
        statement: 'The report includes another person with a similar name.',
      },
    ]);
    check = (await listOwnBackgroundChecks(database, ownerContext))[0];
    await expect(
      adjudicateBackgroundCheck(dependencies(), ownerContext, {
        orderId,
        adjudication: 'ineligible',
        reason: 'Report remains disqualifying.',
        version: check?.version ?? 0,
      }),
    ).rejects.toMatchObject({ code: 'FCRA_WAIT_REQUIRED' });
    clockNow = new Date('2026-10-12T18:00:00.000Z');
    await expect(
      adjudicateBackgroundCheck(dependencies(), ownerContext, {
        orderId,
        adjudication: 'ineligible',
        reason: 'Report remains disqualifying.',
        version: check?.version ?? 0,
      }),
    ).rejects.toMatchObject({ code: 'DISPUTE_PENDING' });
    await resolveBackgroundCheckDispute(dependencies(), ownerContext, {
      disputeId,
      resolution: 'The provider confirmed the correct candidate report.',
      version: 1,
    });
    expect(
      await adjudicateBackgroundCheck(dependencies(), ownerContext, {
        orderId,
        adjudication: 'ineligible',
        reason:
          'The verified report does not meet the volunteer safety standard.',
        version: check?.version ?? 0,
      }),
    ).toMatchObject({ adjudication: 'ineligible' });
    expect(email.messages).toHaveLength(2);
    expect(email.messages[1]?.idempotencyKey).toBe(`fcra-adverse:${orderId}`);
    const finalChecks = await listOwnBackgroundChecks(database, ownerContext);
    expect(finalChecks[0]?.id).toBe(orderId);
    expect(finalChecks[0]?.preAdverseNoticeAt).toBeInstanceOf(Date);
    expect(finalChecks[0]?.adverseNoticeAt).toBeInstanceOf(Date);
    const sentAgain = await resendAdverseActionNotice(
      dependencies(),
      ownerContext,
      orderId,
    );
    expect(sentAgain.delivered).toBe(true);
    expect(email.messages).toHaveLength(2);
  });
});
