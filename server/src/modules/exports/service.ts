import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  organizationExportDownloadLinkSchema,
  organizationExportListSchema,
  organizationExportRequestResponseSchema,
  organizationExportSchema,
  createPrivacyRequestSchema,
  updatePrivacyRequestSchema,
  privacyRequestListSchema,
  privacyRequestSchema,
  privacySubjectExportSchema,
  retentionPolicySchema,
} from '@shared/schemas/exports';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { getDatabase } from '../../db/kysely';
import type { DB, Json } from '../../db/types';
import { createWithOrg, withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import type { Storage } from '../../integrations/storage/storage';
import {
  createStorageKey,
  LocalDiskStorage,
  sha256,
} from '../../integrations/storage/storage';
import { decryptRestricted } from '../../lib/crypto';
import type { EncryptionKeys } from '../../lib/crypto';
import { appendAuditEvent } from '../audit/service';
import { createNotification } from '../notifications/service';
import { sendSchedulingJob } from '../scheduling/generator';

import { serializeReportCsv } from './report-serializers';
import { createZip } from './zip';

const SYSTEM_ACTOR_ID = '0199a1c0-0000-7000-8000-000000000001';
const DOWNLOAD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const EXCLUDED_EXPORT_TABLES = new Set([
  // Bearer-token hashes are authorization material, not organization data.
  'export_download_tokens',
  // Provider signing keys are encrypted integration secrets.
  'provider_delivery_keys',
]);

export class OrganizationExportError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'REAUTH_REQUIRED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'DEPENDENCY_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'OrganizationExportError';
  }
}

type RunWithOrg = typeof withOrg;

function workerContext(orgId: string): OrgContext {
  return { orgId, actor: { accountId: SYSTEM_ACTOR_ID } };
}

async function requireExportManager(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<void> {
  const membership = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  const roles = await trx
    .selectFrom('role_assignments')
    .select('role')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('scope_type', '=', 'org')
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .execute();
  if (
    !membership ||
    !roles.some(({ role }) => role === 'owner' || role === 'admin')
  )
    throw new OrganizationExportError(
      403,
      'FORBIDDEN',
      'Organization owner or admin access is required',
    );
}

function exportSummary(row: {
  id: string;
  status: string;
  bytes: number | null;
  expires_at: Date | null;
  created_at: Date;
}) {
  return organizationExportSchema.parse({
    id: row.id,
    status: row.status,
    bytes: row.bytes,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });
}

export async function requestOrganizationExport(
  context: OrgContext,
  stepUpAuthenticated: boolean,
  enqueue: (orgId: string, exportId: string) => Promise<unknown> = async (
    orgId,
    exportId,
  ) => sendSchedulingJob('exports.build-org', { orgId, exportId }),
  runWithOrg: RunWithOrg = withOrg,
) {
  if (!stepUpAuthenticated)
    throw new OrganizationExportError(
      401,
      'REAUTH_REQUIRED',
      'Re-authenticate before requesting an organization export',
    );
  const created = await runWithOrg(context, async (trx) => {
    await requireExportManager(trx, context);
    const row = await trx
      .insertInto('org_data_exports')
      .values({
        id: randomUUID(),
        org_id: context.orgId,
        requested_by: context.actor.accountId,
        status: 'queued',
        manifest: {},
      })
      .returning(['id', 'status', 'bytes', 'expires_at', 'created_at'])
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'export.created',
      entityType: 'organization_export',
      entityId: row.id,
      changes: { export_kind: { tier: 'internal', after: 'organization' } },
    });
    return exportSummary(row);
  });

  try {
    await enqueue(context.orgId, created.id);
  } catch {
    await runWithOrg(context, async (trx) => {
      await trx
        .updateTable('org_data_exports')
        .set({ status: 'failed', error: 'The export could not be queued' })
        .where('org_id', '=', context.orgId)
        .where('id', '=', created.id)
        .where('status', '=', 'queued')
        .execute();
    });
    throw new OrganizationExportError(
      503,
      'DEPENDENCY_UNAVAILABLE',
      'The organization export could not be queued. Try again shortly.',
    );
  }
  return organizationExportRequestResponseSchema.parse({ export: created });
}

export async function listOrganizationExports(
  context: OrgContext,
  runWithOrg: RunWithOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireExportManager(trx, context);
    const rows = await trx
      .selectFrom('org_data_exports')
      .select(['id', 'status', 'bytes', 'expires_at', 'created_at'])
      .where('org_id', '=', context.orgId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    return organizationExportListSchema.parse({
      items: rows.map(exportSummary),
    });
  });
}

const retentionRules = {
  financialRecordsYears: 7,
  waiverAndSafetyYearsAfterAge18: 7,
  waiverAndSafetyYearsAfterEvent: 7,
  backgroundCheckValidityPlusYears: 1,
  messagesYears: 3,
  evaluationScoresYearsAfterEvent: 2,
  expiredTokensDays: 30,
} as const;

function yearsBefore(date: Date, years: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear() - years,
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

function affectedRows(result: {
  numUpdatedRows?: bigint;
  numDeletedRows?: bigint;
}): number {
  return Number(result.numUpdatedRows ?? result.numDeletedRows ?? 0n);
}

async function expireOrganizationExportArtifacts(
  orgId: string,
  now: Date,
  storage: Storage,
  runWithOrg: RunWithOrg,
) {
  const context = workerContext(orgId);
  const expired = await runWithOrg(context, (trx) =>
    trx
      .selectFrom('org_data_exports')
      .leftJoin('files', (join) =>
        join
          .onRef('files.org_id', '=', 'org_data_exports.org_id')
          .onRef('files.id', '=', 'org_data_exports.file_id'),
      )
      .select([
        'org_data_exports.id as export_id',
        'org_data_exports.status as export_status',
        'org_data_exports.file_id as file_id',
        'files.id as file_row_id',
        'files.storage_key as storage_key',
        'files.deleted_at as file_deleted_at',
      ])
      .where('org_data_exports.org_id', '=', orgId)
      .where('org_data_exports.expires_at', '<=', now)
      .where('org_data_exports.status', 'in', ['ready', 'expired'])
      .where((eb) =>
        eb.or([
          eb('org_data_exports.status', '=', 'ready'),
          eb.and([
            eb('org_data_exports.status', '=', 'expired'),
            eb('org_data_exports.file_id', 'is not', null),
            eb('files.deleted_at', 'is', null),
          ]),
        ]),
      )
      .orderBy('org_data_exports.id')
      .execute(),
  );
  const counts = {
    organizationExportsExpired: 0,
    organizationExportObjectsDeleted: 0,
    organizationExportCleanupPending: 0,
  };

  for (const artifact of expired) {
    const transitioned = await runWithOrg(context, async (trx) => {
      const update = await trx
        .updateTable('org_data_exports')
        .set({ status: 'expired' })
        .where('org_id', '=', orgId)
        .where('id', '=', artifact.export_id)
        .where('status', '=', 'ready')
        .where('expires_at', '<=', now)
        .executeTakeFirst();
      await trx
        .deleteFrom('export_download_tokens')
        .where('org_id', '=', orgId)
        .where('export_id', '=', artifact.export_id)
        .execute();
      const changed = affectedRows(update) > 0;
      if (changed) {
        await appendAuditEvent(trx, context, {
          action: 'export.expired',
          entityType: 'organization_export',
          entityId: artifact.export_id,
          changes: {
            status: {
              tier: 'internal',
              before: artifact.export_status,
              after: 'expired',
            },
          },
        });
      }
      return changed;
    });
    if (transitioned) counts.organizationExportsExpired += 1;

    if (artifact.file_id === null || artifact.file_deleted_at !== null)
      continue;
    if (artifact.file_row_id === null || artifact.storage_key === null) {
      counts.organizationExportCleanupPending += 1;
      continue;
    }

    try {
      // Delete bytes first. If the following DB write fails, the retained key
      // lets the next weekly sweep safely retry this idempotent deletion.
      await storage.delete(artifact.storage_key);
      const retired = await runWithOrg(context, (trx) =>
        trx
          .updateTable('files')
          .set({ deleted_at: now })
          .where('org_id', '=', orgId)
          .where('id', '=', artifact.file_row_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      );
      if (affectedRows(retired) > 0)
        counts.organizationExportObjectsDeleted += 1;
    } catch {
      // Keep file metadata active as a retry marker; expiry already blocks
      // bearer downloads and the next sweep will retry storage cleanup.
      counts.organizationExportCleanupPending += 1;
    }
  }

  return counts;
}

async function purgeRetainedPersonFiles(
  orgId: string,
  now: Date,
  storage: Storage,
  runWithOrg: RunWithOrg,
) {
  const context = workerContext(orgId);
  const pendingPhotos = await runWithOrg(context, (trx) =>
    trx
      .selectFrom('files')
      .select(['id', 'storage_key'])
      .where('org_id', '=', orgId)
      .where('owner_type', '=', 'privacy_photo_purge_pending')
      .where('deleted_at', 'is not', null)
      .orderBy('id')
      .execute(),
  );
  const expiredCredentialIds = (trx: OrgTransaction) =>
    trx
      .selectFrom('person_credentials as credentials')
      .select('credentials.id')
      .where('credentials.org_id', '=', orgId)
      .where(
        sql<boolean>`COALESCE(
          credentials.expires_on,
          credentials.verified_at::date,
          credentials.issued_on,
          credentials.created_at::date
        ) <= (
          ${now}::date - ${retentionRules.backgroundCheckValidityPlusYears} * interval '1 year'
        )::date`,
      );
  const expiredCredentialFiles = await runWithOrg(context, (trx) =>
    trx
      .selectFrom('files')
      .select(['id', 'storage_key'])
      .where('org_id', '=', orgId)
      .where('owner_type', '=', 'credential_evidence_retained')
      .where('deleted_at', 'is not', null)
      .where('owner_id', 'in', expiredCredentialIds(trx))
      .orderBy('id')
      .execute(),
  );
  const counts = {
    privacyPhotoObjectsPurged: 0,
    credentialEvidenceObjectsPurged: 0,
    personFileCleanupPending: 0,
  };

  for (const file of pendingPhotos) {
    try {
      await storage.delete(file.storage_key);
      const retired = await runWithOrg(context, (trx) =>
        trx
          .updateTable('files')
          .set({ owner_type: 'privacy_photo_purged' })
          .where('org_id', '=', orgId)
          .where('id', '=', file.id)
          .where('owner_type', '=', 'privacy_photo_purge_pending')
          .where('deleted_at', 'is not', null)
          .executeTakeFirst(),
      );
      counts.privacyPhotoObjectsPurged += affectedRows(retired);
    } catch {
      counts.personFileCleanupPending += 1;
    }
  }

  for (const file of expiredCredentialFiles) {
    try {
      await storage.delete(file.storage_key);
      const retired = await runWithOrg(context, (trx) =>
        trx
          .updateTable('files')
          .set({ owner_type: 'credential_evidence_purged' })
          .where('org_id', '=', orgId)
          .where('id', '=', file.id)
          .where('owner_type', '=', 'credential_evidence_retained')
          .where('deleted_at', 'is not', null)
          .executeTakeFirst(),
      );
      counts.credentialEvidenceObjectsPurged += affectedRows(retired);
    } catch {
      counts.personFileCleanupPending += 1;
    }
  }

  return counts;
}

/** Apply the retention schedule tenant by tenant while preserving legal records. */
export async function runRetentionSweepJob(
  data: unknown = {},
  now = new Date(),
  database: Kysely<DB> = getDatabase(),
  runWithOrg: RunWithOrg = withOrg,
  storage: Storage = new LocalDiskStorage('data/uploads'),
) {
  z.record(z.string(), z.unknown()).parse(data);
  const organizations = await database
    .selectFrom('organizations')
    .select('id')
    .orderBy('id')
    .execute();
  const summaries: Array<{
    orgId: string;
    runId: string;
    counts: Record<string, number>;
  }> = [];

  for (const { id: orgId } of organizations) {
    const context = workerContext(orgId);
    const runId = randomUUID();
    const startedAt = new Date();

    try {
      const exportExpiry = await expireOrganizationExportArtifacts(
        orgId,
        now,
        storage,
        runWithOrg,
      );
      const personFileCleanup = await purgeRetainedPersonFiles(
        orgId,
        now,
        storage,
        runWithOrg,
      );
      const counts = await runWithOrg(context, async (trx) => {
        const messageCutoff = yearsBefore(now, retentionRules.messagesYears);
        const backgroundCutoff = yearsBefore(
          now,
          retentionRules.backgroundCheckValidityPlusYears,
        );
        const scoreCutoff = yearsBefore(
          now,
          retentionRules.evaluationScoresYearsAfterEvent,
        );
        const retainedMessage = '[Message retained under policy]';

        const chat = await trx
          .updateTable('chat_messages')
          .set({
            body: retainedMessage,
            attachments: JSON.stringify([]) as unknown as Json,
            version: sql<number>`version + 1`,
          })
          .where('org_id', '=', orgId)
          .where('created_at', '<', messageCutoff)
          .where((eb) =>
            eb.or([
              eb('body', '!=', retainedMessage),
              sql<boolean>`attachments <> '[]'::jsonb`,
            ]),
          )
          .executeTakeFirst();
        const deliveries = await trx
          .updateTable('message_deliveries')
          .set({
            address: null,
            provider_message_id: null,
            error: null,
            version: sql<number>`version + 1`,
          })
          .where('org_id', '=', orgId)
          .where('created_at', '<', messageCutoff)
          .where((eb) =>
            eb.or([
              eb('address', 'is not', null),
              eb('provider_message_id', 'is not', null),
              eb('error', 'is not', null),
            ]),
          )
          .executeTakeFirst();
        const campaigns = await trx
          .updateTable('message_campaigns')
          .set({
            subject: null,
            body_html: null,
            body_text: null,
            sms_text: null,
            locale_variants: {} as Json,
            reply_to: null,
            version: sql<number>`version + 1`,
          })
          .where('org_id', '=', orgId)
          .where('sent_at', '<', messageCutoff)
          .where((eb) =>
            eb.or([
              eb('subject', 'is not', null),
              eb('body_html', 'is not', null),
              eb('body_text', 'is not', null),
              eb('sms_text', 'is not', null),
              eb('reply_to', 'is not', null),
              sql<boolean>`locale_variants <> '{}'::jsonb`,
            ]),
          )
          .executeTakeFirst();

        const expiredBackgroundOrders = trx
          .selectFrom('background_check_orders as orders')
          .leftJoin('person_credentials as credentials', (join) =>
            join
              .onRef('credentials.org_id', '=', 'orders.org_id')
              .onRef('credentials.id', '=', 'orders.credential_id'),
          )
          .select('orders.id')
          .where('orders.org_id', '=', orgId)
          .where((eb) =>
            eb.or([
              eb(
                'credentials.expires_on',
                '<',
                new Date(backgroundCutoff.toISOString().slice(0, 10)),
              ),
              eb.and([
                eb('credentials.expires_on', 'is', null),
                eb('orders.completed_at', '<', backgroundCutoff),
              ]),
            ]),
          );
        const background = await trx
          .updateTable('background_check_orders')
          .set({
            details_enc: null,
            provider_candidate_id: null,
            provider_report_id: null,
            version: sql<number>`version + 1`,
          })
          .where('org_id', '=', orgId)
          .where('id', 'in', expiredBackgroundOrders)
          .where((eb) =>
            eb.or([
              eb('details_enc', 'is not', null),
              eb('provider_candidate_id', 'is not', null),
              eb('provider_report_id', 'is not', null),
            ]),
          )
          .executeTakeFirst();

        const expiredEvaluationEvents = trx
          .selectFrom('evaluation_events as event')
          .leftJoin('evaluation_sessions as session', (join) =>
            join
              .onRef('session.org_id', '=', 'event.org_id')
              .onRef('session.evaluation_event_id', '=', 'event.id'),
          )
          .select('event.id')
          .where('event.org_id', '=', orgId)
          .groupBy(['event.id', 'event.created_at'])
          .having(
            sql<boolean>`COALESCE(MAX(session.ends_at), event.created_at) < ${scoreCutoff}`,
          );
        const scores = await trx
          .deleteFrom('evaluation_scores')
          .where('org_id', '=', orgId)
          .where('evaluation_event_id', 'in', expiredEvaluationEvents)
          .executeTakeFirst();
        const results = await trx
          .updateTable('evaluation_results')
          .set({
            normalized_scores: {} as Json,
            composite: null,
            rank_in_group: null,
            missing_criteria: [],
            version: sql<number>`version + 1`,
          })
          .where('org_id', '=', orgId)
          .where('evaluation_event_id', 'in', expiredEvaluationEvents)
          .where((eb) =>
            eb.or([
              eb('composite', 'is not', null),
              eb('rank_in_group', 'is not', null),
              sql<boolean>`normalized_scores <> '{}'::jsonb`,
            ]),
          )
          .executeTakeFirst();

        const counts = {
          ...exportExpiry,
          ...personFileCleanup,
          chatMessagesRedacted: affectedRows(chat),
          messageDeliveriesRedacted: affectedRows(deliveries),
          messageCampaignsRedacted: affectedRows(campaigns),
          backgroundCheckDetailsPurged: affectedRows(background),
          evaluationScoresPurged: affectedRows(scores),
          evaluationResultsRedacted: affectedRows(results),
        };
        await trx
          .insertInto('retention_sweep_runs')
          .values({
            id: runId,
            org_id: orgId,
            started_at: startedAt,
            finished_at: now,
            summary: counts as Json,
          })
          .execute();
        await appendAuditEvent(trx, context, {
          action: 'retention.sweep.completed',
          entityType: 'retention_sweep_run',
          entityId: runId,
          changes: Object.fromEntries(
            Object.entries(counts).map(([key, value]) => [
              key,
              { tier: 'internal' as const, after: value },
            ]),
          ),
        });
        return counts;
      });
      summaries.push({ orgId, runId, counts });
    } catch (error) {
      await runWithOrg(context, async (trx) => {
        await trx
          .insertInto('retention_sweep_runs')
          .values({
            id: runId,
            org_id: orgId,
            started_at: startedAt,
            finished_at: now,
            summary: { state: 'failed' } as Json,
          })
          .execute();
      }).catch(() => undefined);
      throw error;
    }
  }

  const tokenCutoff = new Date(
    now.getTime() - retentionRules.expiredTokensDays * 24 * 60 * 60 * 1000,
  );
  await sql<{ purged: number }>`
    SELECT privacy_purge_expired_auth_tokens(${tokenCutoff}) AS purged
  `.execute(database);
  await database
    .deleteFrom('sessions')
    .where(
      sql<boolean>`COALESCE(revoked_at, LEAST(idle_expires_at, absolute_expires_at)) < ${tokenCutoff}`,
    )
    .execute();

  return { completedOrganizations: summaries.length, summaries };
}

type PrivacyRequestInput = z.infer<typeof createPrivacyRequestSchema>;
type PrivacyRequestUpdate = z.infer<typeof updatePrivacyRequestSchema>;

function privacyRequestSummary(row: {
  id: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  status: string;
  resolution_note: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}) {
  return privacyRequestSchema.parse({
    id: row.id,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    status: row.status,
    resolutionNote: row.resolution_note,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export async function getOrganizationRetentionPolicy(
  context: OrgContext,
  runWithOrg: RunWithOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireExportManager(trx, context);
    let row = await trx
      .selectFrom('retention_policies')
      .select(['rules', 'version', 'updated_at'])
      .where('org_id', '=', context.orgId)
      .executeTakeFirst();
    if (!row) {
      row = await trx
        .insertInto('retention_policies')
        .values({
          org_id: context.orgId,
          rules: retentionRules,
        })
        .returning(['rules', 'version', 'updated_at'])
        .executeTakeFirstOrThrow();
    }
    return retentionPolicySchema.parse({
      version: row.version,
      rules: { ...retentionRules, ...(row.rules as object) },
      updatedAt: row.updated_at.toISOString(),
    });
  });
}

export async function listOrganizationPrivacyRequests(
  context: OrgContext,
  runWithOrg: RunWithOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireExportManager(trx, context);
    const rows = await trx
      .selectFrom('org_privacy_requests')
      .select([
        'id',
        'kind',
        'subject_type',
        'subject_id',
        'status',
        'resolution_note',
        'version',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', context.orgId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return privacyRequestListSchema.parse({
      items: rows.map(privacyRequestSummary),
    });
  });
}

export async function createOrganizationPrivacyRequest(
  context: OrgContext,
  input: PrivacyRequestInput,
  stepUpAuthenticated: boolean,
  runWithOrg: RunWithOrg = withOrg,
) {
  if (!stepUpAuthenticated)
    throw new OrganizationExportError(
      401,
      'REAUTH_REQUIRED',
      'Re-authenticate before creating a privacy request',
    );
  return runWithOrg(context, async (trx) => {
    await requireExportManager(trx, context);
    const subject =
      input.subjectType === 'person'
        ? await trx
            .selectFrom('people')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('id', '=', input.subjectId)
            .executeTakeFirst()
        : await trx
            .selectFrom('households')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('id', '=', input.subjectId)
            .executeTakeFirst();
    if (!subject)
      throw new OrganizationExportError(
        404,
        'NOT_FOUND',
        'Privacy request subject not found',
      );
    const duplicate = await trx
      .selectFrom('org_privacy_requests')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('kind', '=', input.kind)
      .where('subject_type', '=', input.subjectType)
      .where('subject_id', '=', input.subjectId)
      .where('status', 'in', ['pending', 'in_review', 'approved'])
      .executeTakeFirst();
    if (duplicate)
      throw new OrganizationExportError(
        409,
        'CONFLICT',
        'An open request of this type already exists for the subject',
      );
    const row = await trx
      .insertInto('org_privacy_requests')
      .values({
        id: randomUUID(),
        org_id: context.orgId,
        kind: input.kind,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        requested_by: context.actor.accountId,
        details: {},
      })
      .returning([
        'id',
        'kind',
        'subject_type',
        'subject_id',
        'status',
        'resolution_note',
        'version',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'privacy.request.created',
      entityType: 'privacy_request',
      entityId: row.id,
      changes: {
        kind: { tier: 'internal', after: row.kind },
        subject_type: { tier: 'sensitive', after: row.subject_type },
        subject_id: { tier: 'sensitive', after: row.subject_id },
      },
    });
    return privacyRequestSummary(row);
  });
}

interface PrivacyPhotoCleanup {
  id: string;
  storageKey: string;
}

interface PersonAnonymizationResult {
  redactedFormResponseCount: number;
  photoFile: PrivacyPhotoCleanup | null;
}

async function anonymizePerson(
  trx: OrgTransaction,
  context: OrgContext,
  personId: string,
  now: Date,
): Promise<PersonAnonymizationResult> {
  const person = await trx
    .selectFrom('people')
    .select(['id', 'photo_file_id'])
    .where('org_id', '=', context.orgId)
    .where('id', '=', personId)
    .executeTakeFirst();
  if (!person)
    throw new OrganizationExportError(
      404,
      'NOT_FOUND',
      'Privacy request subject not found',
    );

  const memberships = await trx
    .selectFrom('household_members')
    .select('household_id')
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .execute();
  const credentialFiles = await trx
    .selectFrom('person_credentials')
    .select(['id', 'file_id'])
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .where('file_id', 'is not', null)
    .execute();

  await trx
    .updateTable('people')
    .set({
      first_name: 'Deleted',
      last_name: 'Person',
      preferred_name: null,
      middle_name: null,
      suffix: null,
      date_of_birth: '1900-01-01',
      gender: 'unspecified',
      competition_gender: null,
      email: null,
      phone_e164: null,
      address: null,
      graduation_year: null,
      school_name: null,
      photo_file_id: null,
      media_consent: 'unknown',
      status: 'anonymized',
      version: sql<number>`version + 1`,
    })
    .where('org_id', '=', context.orgId)
    .where('id', '=', personId)
    .execute();
  await trx
    .updateTable('person_account_links')
    .set({ revoked_at: now })
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .where('revoked_at', 'is', null)
    .execute();
  await trx
    .updateTable('emergency_contacts')
    .set({
      name: 'Deleted Contact',
      relationship: 'redacted',
      phone_e164: 'REDACTED',
      alt_phone_e164: null,
    })
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .execute();
  await trx
    .updateTable('medical_profiles')
    .set({
      allergies_enc: null,
      allergy_flags: [],
      conditions_enc: null,
      medications_enc: null,
      physician_name_enc: null,
      physician_phone_enc: null,
      insurance_carrier_enc: null,
      insurance_policy_enc: null,
      notes_enc: null,
      updated_by: null,
      version: sql<number>`version + 1`,
    })
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .execute();
  await trx
    .updateTable('person_credentials')
    .set({
      identifier_enc: null,
      file_id: null,
      rejection_reason: null,
      provider_reference: null,
      version: sql<number>`version + 1`,
    })
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .execute();
  await trx
    .updateTable('background_check_orders')
    .set({
      provider_candidate_id: null,
      provider_report_id: null,
      details_enc: null,
      version: sql<number>`version + 1`,
    })
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .execute();
  await trx
    .updateTable('evaluation_participants')
    .set({
      media_consent: false,
      photo_file_id: null,
      version: sql<number>`version + 1`,
    })
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .execute();
  await trx
    .updateTable('athlete_cards')
    .set({
      status: 'revoked',
      photo_file_id: null,
      version: sql<number>`version + 1`,
    })
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', personId)
    .execute();
  const credentialFileIds = credentialFiles.flatMap(({ file_id }) =>
    file_id ? [file_id] : [],
  );
  if (credentialFileIds.length > 0)
    await trx
      .updateTable('files')
      .set({
        deleted_at: now,
        owner_type: 'credential_evidence_retained',
      })
      .where('org_id', '=', context.orgId)
      .where('id', 'in', credentialFileIds)
      .where('deleted_at', 'is', null)
      .execute();
  const photoFile = person.photo_file_id
    ? await trx
        .updateTable('files')
        .set({
          deleted_at: now,
          owner_type: 'privacy_photo_purge_pending',
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', person.photo_file_id)
        .where('deleted_at', 'is', null)
        .returning(['id', 'storage_key'])
        .executeTakeFirst()
    : undefined;

  const redactedAnswers = await sql<{ redacted_count: number }>`
    SELECT privacy_redact_person_form_responses(
      ${context.orgId}::uuid,
      ${personId}::uuid
    ) AS redacted_count
  `.execute(trx);

  for (const { household_id: householdId } of memberships) {
    const otherActiveMembers = await trx
      .selectFrom('household_members as member')
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'member.org_id')
          .onRef('person.id', '=', 'member.person_id'),
      )
      .select('member.id')
      .where('member.org_id', '=', context.orgId)
      .where('member.household_id', '=', householdId)
      .where('member.person_id', '!=', personId)
      .where('person.status', '=', 'active')
      .limit(1)
      .executeTakeFirst();
    if (!otherActiveMembers) {
      await trx
        .updateTable('households')
        .set({ name: 'Deleted Household', address: null, status: 'archived' })
        .where('org_id', '=', context.orgId)
        .where('id', '=', householdId)
        .execute();
    }
  }
  return {
    redactedFormResponseCount: redactedAnswers.rows[0]?.redacted_count ?? 0,
    photoFile: photoFile
      ? { id: photoFile.id, storageKey: photoFile.storage_key }
      : null,
  };
}

export async function updateOrganizationPrivacyRequest(
  context: OrgContext,
  requestId: string,
  input: PrivacyRequestUpdate,
  stepUpAuthenticated: boolean,
  now = new Date(),
  runWithOrg: RunWithOrg = withOrg,
  storage: Storage = new LocalDiskStorage('data/uploads'),
) {
  if (!stepUpAuthenticated)
    throw new OrganizationExportError(
      401,
      'REAUTH_REQUIRED',
      'Re-authenticate before updating a privacy request',
    );
  const result = await runWithOrg(context, async (trx) => {
    await requireExportManager(trx, context);
    const current = await trx
      .selectFrom('org_privacy_requests')
      .select(['id', 'kind', 'subject_type', 'subject_id', 'status', 'version'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', requestId)
      .executeTakeFirst();
    if (!current)
      throw new OrganizationExportError(
        404,
        'NOT_FOUND',
        'Privacy request not found',
      );
    if (current.version !== input.version)
      throw new OrganizationExportError(
        409,
        'CONFLICT',
        'Privacy request changed; refresh before updating it',
      );
    const transitions: Record<string, readonly string[]> = {
      pending: ['in_review', 'rejected'],
      in_review: ['approved', 'rejected'],
      approved: ['completed', 'rejected'],
      completed: [],
      rejected: [],
    };
    if (!transitions[current.status]?.includes(input.status))
      throw new OrganizationExportError(
        409,
        'CONFLICT',
        'This privacy request cannot move to the requested status',
      );
    const note = input.resolutionNote?.trim() || null;
    if ((input.status === 'completed' || input.status === 'rejected') && !note)
      throw new OrganizationExportError(
        400,
        'CONFLICT',
        'A resolution note is required to complete or reject a request',
      );

    const deletionNoticeAccounts = new Set<string>();
    let redactedFormResponseCount = 0;
    const photoFiles: PrivacyPhotoCleanup[] = [];
    if (input.status === 'completed' && current.kind === 'deletion') {
      let subjectPersonIds: string[];
      if (current.subject_type === 'person') {
        subjectPersonIds = [current.subject_id];
        const anonymized = await anonymizePerson(
          trx,
          context,
          current.subject_id,
          now,
        );
        redactedFormResponseCount = anonymized.redactedFormResponseCount;
        if (anonymized.photoFile) photoFiles.push(anonymized.photoFile);
      } else {
        const memberRows = await trx
          .selectFrom('household_members')
          .select('person_id')
          .where('org_id', '=', context.orgId)
          .where('household_id', '=', current.subject_id)
          .execute();
        subjectPersonIds = memberRows.map(({ person_id }) => person_id);
        if (subjectPersonIds.length > 0) {
          const links = await trx
            .selectFrom('person_account_links')
            .select('account_id')
            .where('org_id', '=', context.orgId)
            .where('person_id', 'in', subjectPersonIds)
            .where('revoked_at', 'is', null)
            .execute();
          for (const { account_id: accountId } of links)
            deletionNoticeAccounts.add(accountId);
        }
        for (const { person_id: personId } of memberRows) {
          const anonymized = await anonymizePerson(trx, context, personId, now);
          redactedFormResponseCount += anonymized.redactedFormResponseCount;
          if (anonymized.photoFile) photoFiles.push(anonymized.photoFile);
        }
        await trx
          .updateTable('households')
          .set({ name: 'Deleted Household', address: null, status: 'archived' })
          .where('org_id', '=', context.orgId)
          .where('id', '=', current.subject_id)
          .execute();
      }
      if (current.subject_type === 'person') {
        const links = await trx
          .selectFrom('person_account_links')
          .select('account_id')
          .where('org_id', '=', context.orgId)
          .where('person_id', 'in', subjectPersonIds)
          .execute();
        for (const { account_id: accountId } of links)
          deletionNoticeAccounts.add(accountId);
      }
    }

    const row = await trx
      .updateTable('org_privacy_requests')
      .set({
        status: input.status,
        resolution_note: note,
        version: sql<number>`version + 1`,
        completed_at: input.status === 'completed' ? now : null,
        completed_by:
          input.status === 'completed' ? context.actor.accountId : null,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', requestId)
      .where('version', '=', input.version)
      .returning([
        'id',
        'kind',
        'subject_type',
        'subject_id',
        'status',
        'resolution_note',
        'version',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirst();
    if (!row)
      throw new OrganizationExportError(
        409,
        'CONFLICT',
        'Privacy request changed; refresh before updating it',
      );
    await appendAuditEvent(trx, context, {
      action: 'privacy.request.status_changed',
      entityType: 'privacy_request',
      entityId: requestId,
      changes: {
        status: {
          tier: 'internal',
          before: current.status,
          after: input.status,
        },
        subject_type: { tier: 'sensitive', after: current.subject_type },
        subject_id: { tier: 'sensitive', after: current.subject_id },
        ...(input.status === 'completed' && current.kind === 'deletion'
          ? {
              redacted_form_responses: {
                tier: 'internal' as const,
                after: redactedFormResponseCount,
              },
            }
          : {}),
      },
    });
    if (input.status === 'completed' && current.kind === 'deletion') {
      for (const accountId of deletionNoticeAccounts) {
        await createNotification(trx, context, {
          accountId,
          type: 'privacy_request.updated',
          payload: {
            resourceType: 'privacy_request',
            resourceId: requestId,
          },
        });
      }
    }
    return { summary: privacyRequestSummary(row), photoFiles };
  });
  for (const photo of result.photoFiles) {
    try {
      await storage.delete(photo.storageKey);
      await runWithOrg(context, (trx) =>
        trx
          .updateTable('files')
          .set({ owner_type: 'privacy_photo_purged' })
          .where('org_id', '=', context.orgId)
          .where('id', '=', photo.id)
          .where('owner_type', '=', 'privacy_photo_purge_pending')
          .where('deleted_at', 'is not', null)
          .executeTakeFirst(),
      );
    } catch {
      // The retention sweep retries rows that still have the pending marker.
    }
  }
  return result.summary;
}

export async function createPrivacySubjectExport(
  context: OrgContext,
  requestId: string,
  stepUpAuthenticated: boolean,
  now = new Date(),
  runWithOrg: RunWithOrg = withOrg,
  encryption?: EncryptionKeys,
) {
  if (!stepUpAuthenticated)
    throw new OrganizationExportError(
      401,
      'REAUTH_REQUIRED',
      'Re-authenticate before exporting subject data',
    );
  return runWithOrg(context, async (trx) => {
    await requireExportManager(trx, context);
    const request = await trx
      .selectFrom('org_privacy_requests')
      .select(['id', 'kind', 'subject_type', 'subject_id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', requestId)
      .executeTakeFirst();
    if (!request)
      throw new OrganizationExportError(
        404,
        'NOT_FOUND',
        'Privacy request not found',
      );
    if (request.kind !== 'access' || request.status !== 'approved')
      throw new OrganizationExportError(
        409,
        'CONFLICT',
        'Only an approved access request can produce a subject export',
      );

    const data: Record<string, unknown> = {};
    let personIds: string[] = [];
    if (request.subject_type === 'person') {
      const person = await trx
        .selectFrom('people')
        .select([
          'id',
          'first_name',
          'last_name',
          'preferred_name',
          'date_of_birth',
          'gender',
          'competition_gender',
          'email',
          'phone_e164',
          'address',
          'graduation_year',
          'school_name',
          'media_consent',
          'status',
        ])
        .where('org_id', '=', context.orgId)
        .where('id', '=', request.subject_id)
        .executeTakeFirst();
      if (!person)
        throw new OrganizationExportError(
          404,
          'NOT_FOUND',
          'Privacy request subject not found',
        );
      data.person = person;
      personIds = [person.id];
    } else {
      const household = await trx
        .selectFrom('households')
        .select(['id', 'name', 'address', 'status', 'created_at'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', request.subject_id)
        .executeTakeFirst();
      if (!household)
        throw new OrganizationExportError(
          404,
          'NOT_FOUND',
          'Privacy request subject not found',
        );
      data.household = household;
      const members = await trx
        .selectFrom('household_members as member')
        .innerJoin('people as person', (join) =>
          join
            .onRef('person.org_id', '=', 'member.org_id')
            .onRef('person.id', '=', 'member.person_id'),
        )
        .select([
          'member.role',
          'member.is_primary_contact',
          'member.receives_communications',
          'member.financially_responsible',
          'person.id as person_id',
          'person.first_name',
          'person.last_name',
          'person.preferred_name',
          'person.date_of_birth',
          'person.email',
          'person.phone_e164',
          'person.status',
        ])
        .where('member.org_id', '=', context.orgId)
        .where('member.household_id', '=', request.subject_id)
        .limit(250)
        .execute();
      data.members = members;
      personIds = members.map(({ person_id }) => person_id);
    }

    if (personIds.length > 0) {
      data.registrations = await trx
        .selectFrom('registrations')
        .innerJoin('programs', (join) =>
          join
            .onRef('programs.org_id', '=', 'registrations.org_id')
            .onRef('programs.id', '=', 'registrations.program_id'),
        )
        .select([
          'registrations.id',
          'programs.name as program_name',
          'registrations.status',
          'registrations.source',
          'registrations.created_at',
        ])
        .where('registrations.org_id', '=', context.orgId)
        .where('registrations.person_id', 'in', personIds)
        .orderBy('registrations.created_at', 'desc')
        .limit(500)
        .execute();
      data.attendance = await trx
        .selectFrom('attendance')
        .select([
          'event_id',
          'status',
          'rsvp',
          'checked_in_at',
          'checked_out_at',
          'created_at',
        ])
        .where('org_id', '=', context.orgId)
        .where('person_id', 'in', personIds)
        .orderBy('created_at', 'desc')
        .limit(500)
        .execute();
      data.waiverSignatures = await trx
        .selectFrom('waiver_signatures')
        .select([
          'id',
          'participant_person_id',
          'document_version',
          'document_hash',
          'method',
          'signed_at',
        ])
        .where('org_id', '=', context.orgId)
        .where('participant_person_id', 'in', personIds)
        .orderBy('signed_at', 'desc')
        .limit(500)
        .execute();
      data.credentials = await trx
        .selectFrom('person_credentials')
        .innerJoin('credential_types', (join) =>
          join
            .onRef('credential_types.org_id', '=', 'person_credentials.org_id')
            .onRef(
              'credential_types.id',
              '=',
              'person_credentials.credential_type_id',
            ),
        )
        .select([
          'credential_types.name as credential_type',
          'person_credentials.status',
          'person_credentials.issued_on',
          'person_credentials.expires_on',
        ])
        .where('person_credentials.org_id', '=', context.orgId)
        .where('person_credentials.person_id', 'in', personIds)
        .orderBy('person_credentials.created_at', 'desc')
        .limit(250)
        .execute();

      const emergencyContacts = await trx
        .selectFrom('emergency_contacts')
        .select([
          'person_id',
          'name',
          'relationship',
          'phone_e164',
          'alt_phone_e164',
          'priority',
        ])
        .where('org_id', '=', context.orgId)
        .where('person_id', 'in', personIds)
        .orderBy('priority')
        .limit(500)
        .execute();
      data.emergencyContacts = emergencyContacts;

      const formResponses = await trx
        .selectFrom('form_responses')
        .select([
          'id',
          'subject_type',
          'subject_id',
          'definition_version',
          'answers',
          'answers_enc',
          'submitted_at',
        ])
        .where('org_id', '=', context.orgId)
        .where((eb) =>
          eb.or([
            eb('subject_type', '=', 'person').and(
              'subject_id',
              'in',
              personIds,
            ),
            eb('subject_type', '=', 'registration').and(
              'subject_id',
              'in',
              trx
                .selectFrom('registrations')
                .select('id')
                .where('org_id', '=', context.orgId)
                .where('person_id', 'in', personIds),
            ),
          ]),
        )
        .orderBy('submitted_at', 'desc')
        .limit(500)
        .execute();
      data.formResponses = formResponses.map((response) => {
        if (!response.answers_enc) return response;
        if (!encryption)
          throw new OrganizationExportError(
            503,
            'DEPENDENCY_UNAVAILABLE',
            'Restricted response export is unavailable',
          );
        return {
          ...response,
          answers_enc: undefined,
          restrictedAnswers: JSON.parse(
            decryptRestricted(response.answers_enc, encryption).toString(
              'utf8',
            ),
          ) as unknown,
        };
      });
      for (const response of formResponses) {
        if (!response.answers_enc) continue;
        await appendAuditEvent(trx, context, {
          action: 'restricted.read',
          entityType: 'form_response',
          entityId: response.id,
          changes: {
            answers: { tier: 'restricted', after: '[exported]' },
          },
        });
      }

      const medicalRows = await trx
        .selectFrom('medical_profiles')
        .select([
          'id',
          'person_id',
          'allergies_enc',
          'allergy_flags',
          'conditions_enc',
          'medications_enc',
          'physician_name_enc',
          'physician_phone_enc',
          'insurance_carrier_enc',
          'insurance_policy_enc',
          'notes_enc',
        ])
        .where('org_id', '=', context.orgId)
        .where('person_id', 'in', personIds)
        .limit(250)
        .execute();
      data.medicalProfiles = medicalRows.map((profile) => {
        if (
          !encryption &&
          [
            profile.allergies_enc,
            profile.conditions_enc,
            profile.medications_enc,
            profile.physician_name_enc,
            profile.physician_phone_enc,
            profile.insurance_carrier_enc,
            profile.insurance_policy_enc,
            profile.notes_enc,
          ].some(Boolean)
        )
          throw new OrganizationExportError(
            503,
            'DEPENDENCY_UNAVAILABLE',
            'Restricted medical export is unavailable',
          );
        const decode = (value: Buffer | null) =>
          value && encryption
            ? decryptRestricted(value, encryption).toString('utf8')
            : null;
        return {
          personId: profile.person_id,
          allergyFlags: profile.allergy_flags,
          allergies: decode(profile.allergies_enc),
          conditions: decode(profile.conditions_enc),
          medications: decode(profile.medications_enc),
          physicianName: decode(profile.physician_name_enc),
          physicianPhone: decode(profile.physician_phone_enc),
          insuranceCarrier: decode(profile.insurance_carrier_enc),
          insurancePolicy: decode(profile.insurance_policy_enc),
          notes: decode(profile.notes_enc),
        };
      });
      for (const profile of medicalRows) {
        if (
          [
            profile.allergies_enc,
            profile.conditions_enc,
            profile.medications_enc,
            profile.physician_name_enc,
            profile.physician_phone_enc,
            profile.insurance_carrier_enc,
            profile.insurance_policy_enc,
            profile.notes_enc,
          ].some(Boolean)
        )
          await appendAuditEvent(trx, context, {
            action: 'restricted.read',
            entityType: 'medical_profile',
            entityId: profile.person_id,
            changes: {
              medical_data: { tier: 'restricted', after: '[exported]' },
            },
          });
      }
    }
    const householdIds =
      request.subject_type === 'household'
        ? [request.subject_id]
        : await trx
            .selectFrom('household_members')
            .select('household_id')
            .where('org_id', '=', context.orgId)
            .where('person_id', '=', request.subject_id)
            .execute()
            .then((rows) => rows.map(({ household_id }) => household_id));
    if (householdIds.length > 0)
      data.invoices = await trx
        .selectFrom('invoices')
        .select([
          'id',
          'number',
          'status',
          'currency',
          'total_cents',
          'paid_cents',
          'balance_cents',
          'due_on',
          'created_at',
        ])
        .where('org_id', '=', context.orgId)
        .where('household_id', 'in', householdIds)
        .orderBy('created_at', 'desc')
        .limit(500)
        .execute();

    const result = privacySubjectExportSchema.parse({
      requestId: request.id,
      generatedAt: now.toISOString(),
      subjectType: request.subject_type,
      subjectId: request.subject_id,
      data,
    });
    await appendAuditEvent(trx, context, {
      action: 'privacy.access_export.generated',
      entityType: 'privacy_request',
      entityId: request.id,
      changes: {
        subject_type: { tier: 'sensitive', after: request.subject_type },
        subject_id: { tier: 'sensitive', after: request.subject_id },
      },
    });
    return result;
  });
}

export async function createOrganizationExportDownloadLink(
  context: OrgContext,
  exportId: string,
  stepUpAuthenticated: boolean,
  appUrl: string,
  now = new Date(),
  runWithOrg: RunWithOrg = withOrg,
) {
  if (!stepUpAuthenticated)
    throw new OrganizationExportError(
      401,
      'REAUTH_REQUIRED',
      'Re-authenticate before creating a download link',
    );
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = await runWithOrg(context, async (trx) => {
    await requireExportManager(trx, context);
    const exportRow = await trx
      .selectFrom('org_data_exports')
      .select(['id', 'status', 'expires_at'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', exportId)
      .executeTakeFirst();
    if (!exportRow)
      throw new OrganizationExportError(
        404,
        'NOT_FOUND',
        'Organization export not found',
      );
    if (
      exportRow.status !== 'ready' ||
      !exportRow.expires_at ||
      exportRow.expires_at <= now
    )
      throw new OrganizationExportError(
        409,
        'CONFLICT',
        'The organization export is not available for download',
      );
    const expiry = new Date(
      Math.min(
        now.getTime() + DOWNLOAD_LIFETIME_MS,
        exportRow.expires_at.getTime(),
      ),
    );
    await trx
      .deleteFrom('export_download_tokens')
      .where('org_id', '=', context.orgId)
      .where('export_id', '=', exportId)
      .execute();
    await sql`
      INSERT INTO export_download_tokens (token_hash, export_id, org_id, expires_at)
      VALUES (${tokenHash}, ${exportId}, ${context.orgId}, ${expiry})
    `.execute(trx);
    await appendAuditEvent(trx, context, {
      action: 'export.download_link_issued',
      entityType: 'organization_export',
      entityId: exportId,
      changes: {
        expires_at: { tier: 'internal', after: expiry.toISOString() },
      },
    });
    return expiry;
  });
  const base = new URL(appUrl);
  return organizationExportDownloadLinkSchema.parse({
    url: new URL(
      `/api/v1/exports/download/${encodeURIComponent(token)}`,
      base,
    ).toString(),
    expiresAt: expiresAt.toISOString(),
  });
}

interface TenantTableColumn {
  table_name: string;
  column_name: string;
}

interface OrgFileManifestRow {
  id: string;
  purpose: string;
  owner_type: string | null;
  owner_id: string | null;
  mime: string;
  bytes: number;
  sensitivity: string;
  sha256: string | null;
  created_at: Date;
}

function tableCsvName(tableName: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(tableName))
    throw new Error('Unexpected organization table name');
  return `tables/${tableName}.csv`;
}

export async function buildOrganizationExport(
  orgId: string,
  exportId: string,
  database: Kysely<DB> = getDatabase(),
  storage: Storage = new LocalDiskStorage('data/uploads'),
  now = new Date(),
): Promise<{ status: 'ready' | 'already_ready'; bytes: number | null }> {
  const runWithOrg = createWithOrg(database);
  const context = workerContext(orgId);
  const storageKeyRef: { current: string | null } = { current: null };
  try {
    return await runWithOrg(context, async (trx) => {
      const exportRow = await trx
        .selectFrom('org_data_exports')
        .select(['id', 'status', 'requested_by'])
        .where('org_id', '=', orgId)
        .where('id', '=', exportId)
        .forUpdate()
        .executeTakeFirst();
      if (!exportRow)
        throw new OrganizationExportError(
          404,
          'NOT_FOUND',
          'Organization export not found',
        );
      if (exportRow.status === 'ready')
        return { status: 'already_ready', bytes: null };
      if (!['queued', 'building'].includes(exportRow.status))
        throw new OrganizationExportError(
          409,
          'CONFLICT',
          'Organization export is no longer buildable',
        );
      await trx
        .updateTable('org_data_exports')
        .set({ status: 'building', error: null })
        .where('org_id', '=', orgId)
        .where('id', '=', exportId)
        .execute();

      const metadata = await sql<TenantTableColumn>`
        SELECT c.relname AS table_name, a.attname AS column_name
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a
          ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relrowsecurity
          AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_attribute tenant_column
            WHERE tenant_column.attrelid = c.oid
              AND tenant_column.attname = 'org_id'
              AND tenant_column.attnum > 0
              AND NOT tenant_column.attisdropped
          )
        ORDER BY c.relname, a.attnum
      `.execute(trx);
      const columnsByTable = new Map<string, string[]>();
      for (const column of metadata.rows) {
        if (EXCLUDED_EXPORT_TABLES.has(column.table_name)) continue;
        const columns = columnsByTable.get(column.table_name) ?? [];
        columns.push(column.column_name);
        columnsByTable.set(column.table_name, columns);
      }

      const entries = [];
      const tableCounts: Record<string, number> = {};
      for (const [tableName, columns] of columnsByTable) {
        const result = await sql<Record<string, unknown>>`
          SELECT * FROM ${sql.table(tableName)}
          WHERE org_id = ${orgId}
        `.execute(trx);
        entries.push({
          name: tableCsvName(tableName),
          data: serializeReportCsv({
            columns: columns.map((key) => ({ key, label: key, type: 'text' })),
            rows: result.rows.map((row) =>
              columns.map((column) => row[column]),
            ),
          }),
        });
        tableCounts[tableName] = result.rows.length;
      }

      const fileRows = await sql<OrgFileManifestRow>`
        SELECT id, purpose, owner_type, owner_id, mime, bytes,
          sensitivity, sha256, created_at
        FROM files
        WHERE org_id = ${orgId} AND deleted_at IS NULL
        ORDER BY created_at, id
      `.execute(trx);
      entries.push({
        name: 'files/manifest.csv',
        data: serializeReportCsv({
          columns: [
            { key: 'id', label: 'id', type: 'text' },
            { key: 'purpose', label: 'purpose', type: 'text' },
            { key: 'owner_type', label: 'owner_type', type: 'text' },
            { key: 'owner_id', label: 'owner_id', type: 'text' },
            { key: 'mime', label: 'mime', type: 'text' },
            { key: 'bytes', label: 'bytes', type: 'number' },
            { key: 'sensitivity', label: 'sensitivity', type: 'text' },
            { key: 'sha256', label: 'sha256', type: 'text' },
            { key: 'created_at', label: 'created_at', type: 'datetime' },
          ],
          rows: fileRows.rows.map((file) => [
            file.id,
            file.purpose,
            file.owner_type,
            file.owner_id,
            file.mime,
            file.bytes,
            file.sensitivity,
            file.sha256,
            file.created_at,
          ]),
        }),
      });
      const manifest = {
        format: 'athlentry-organization-export-v1',
        generatedAt: now.toISOString(),
        organizationId: orgId,
        tables: tableCounts,
        files: fileRows.rows.length,
        omittedSecurityTables: [...EXCLUDED_EXPORT_TABLES].sort(),
      };
      entries.push({
        name: 'manifest.json',
        data: new TextEncoder().encode(
          `${JSON.stringify(manifest, null, 2)}\n`,
        ),
      });
      const archive = createZip(entries);
      const digest = sha256(archive);
      const fileId = randomUUID();
      const expiresAt = new Date(now.getTime() + DOWNLOAD_LIFETIME_MS);
      const storageKey = createStorageKey(orgId, 'document', 'zip');
      storageKeyRef.current = storageKey;
      await storage.put(storageKey, archive, 'application/zip');
      await trx
        .insertInto('files')
        .values({
          id: fileId,
          org_id: orgId,
          purpose: 'document',
          owner_type: 'organization_export',
          owner_id: exportId,
          storage_key: storageKey,
          mime: 'application/zip',
          bytes: archive.byteLength,
          sha256: digest,
          width: null,
          height: null,
          sensitivity: 'sensitive',
          created_by: exportRow.requested_by,
          upload_state: 'complete',
          expires_at: expiresAt,
        })
        .execute();
      await trx
        .updateTable('org_data_exports')
        .set({
          status: 'ready',
          manifest: manifest as Json,
          file_id: fileId,
          bytes: archive.byteLength,
          expires_at: expiresAt,
          completed_at: now,
          error: null,
        })
        .where('org_id', '=', orgId)
        .where('id', '=', exportId)
        .execute();
      await appendAuditEvent(trx, context, {
        action: 'export.ready',
        entityType: 'organization_export',
        entityId: exportId,
        changes: {
          bytes: { tier: 'internal', after: archive.byteLength },
          file_count: { tier: 'internal', after: fileRows.rows.length },
          table_count: {
            tier: 'internal',
            after: Object.keys(tableCounts).length,
          },
        },
      });
      return { status: 'ready', bytes: archive.byteLength };
    });
  } catch (error) {
    if (storageKeyRef.current)
      await storage.delete(storageKeyRef.current).catch(() => undefined);
    await runWithOrg(context, async (trx) => {
      await trx
        .updateTable('org_data_exports')
        .set({
          status: 'failed',
          error: 'The organization export could not be generated',
        })
        .where('org_id', '=', orgId)
        .where('id', '=', exportId)
        .where('status', 'in', ['queued', 'building'])
        .execute();
    });
    throw error;
  }
}

export interface OrganizationExportJobDependencies {
  database?: Kysely<DB>;
  storage?: Storage;
  now?: Date;
}

export async function runOrganizationExportJob(
  input: unknown,
  dependencies: OrganizationExportJobDependencies = {},
): Promise<{ status: 'ready' | 'already_ready'; bytes: number | null }> {
  const { orgId, exportId } = z
    .strictObject({ orgId: z.uuid(), exportId: z.uuid() })
    .parse(input);
  return buildOrganizationExport(
    orgId,
    exportId,
    dependencies.database ?? getDatabase(),
    dependencies.storage ?? new LocalDiskStorage('data/uploads'),
    dependencies.now ?? new Date(),
  );
}

export async function downloadOrganizationExport(
  token: string,
  database: Kysely<DB> = getDatabase(),
  storage: Storage = new LocalDiskStorage('data/uploads'),
  now = new Date(),
): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new OrganizationExportError(
      404,
      'NOT_FOUND',
      'Organization export not found',
    );
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const downloadToken = await sql<{
    org_id: string;
    export_id: string;
    expires_at: Date;
  }>`
    SELECT org_id, export_id, expires_at
    FROM export_download_tokens
    WHERE token_hash = ${tokenHash} AND expires_at > ${now}
  `.execute(database);
  const grant = downloadToken.rows[0];
  if (!grant)
    throw new OrganizationExportError(
      404,
      'NOT_FOUND',
      'Organization export not found',
    );
  const context = workerContext(grant.org_id);
  const file = await createWithOrg(database)(context, async (trx) => {
    const exportRow = await trx
      .selectFrom('org_data_exports')
      .innerJoin('files', (join) =>
        join
          .onRef('files.org_id', '=', 'org_data_exports.org_id')
          .onRef('files.id', '=', 'org_data_exports.file_id'),
      )
      .select([
        'files.storage_key',
        'files.sha256',
        'org_data_exports.status',
        'org_data_exports.expires_at',
      ])
      .where('org_data_exports.org_id', '=', grant.org_id)
      .where('org_data_exports.id', '=', grant.export_id)
      .executeTakeFirst();
    if (
      !exportRow ||
      exportRow.status !== 'ready' ||
      !exportRow.expires_at ||
      exportRow.expires_at <= now
    )
      throw new OrganizationExportError(
        404,
        'NOT_FOUND',
        'Organization export not found',
      );
    return exportRow;
  });
  const object = await storage.get(file.storage_key);
  if (!object || sha256(object.bytes) !== file.sha256)
    throw new OrganizationExportError(
      404,
      'NOT_FOUND',
      'Organization export not found',
    );
  return object.bytes;
}
