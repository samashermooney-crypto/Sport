import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  organizationExportDownloadLinkSchema,
  organizationExportListSchema,
  organizationExportRequestResponseSchema,
  organizationExportSchema,
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
import { appendAuditEvent } from '../audit/service';
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

export async function runOrganizationExportJob(
  input: unknown,
): Promise<{ status: 'ready' | 'already_ready'; bytes: number | null }> {
  const { orgId, exportId } = z
    .strictObject({ orgId: z.uuid(), exportId: z.uuid() })
    .parse(input);
  return buildOrganizationExport(orgId, exportId);
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
