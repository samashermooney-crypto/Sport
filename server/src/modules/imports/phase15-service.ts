import { newId } from '@shared/ids';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import type { DB, JsonObject } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgTransaction } from '../../db/withOrg';
import type { Storage } from '../../integrations/storage/storage';
import { createStorageKey } from '../../integrations/storage/storage';
import type { EncryptionKeys } from '../../lib/crypto';

import { importFields } from './phase15-fields';
import type { CommitContext } from './phase15-kinds';
import { importKinds } from './phase15-kinds';
import type { ParsedTable } from './phase15-parse';
import { ImportParseError, parseImportFile } from './phase15-parse';
import type {
  ImportBatch,
  ImportDuplicate,
  ImportIssue,
  ImportKind,
  ImportMapping,
  ImportRow,
} from './phase15-schema';
import { isZip, readZip } from './phase15-zip';

export class ImportsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const importRoles: Partial<Record<ImportKind, string[]>> = {
  historical_payments: ['owner', 'admin', 'finance'],
  volunteer_hours: ['owner', 'admin', 'registrar', 'volunteer_coordinator'],
};
const defaultImportRoles = ['owner', 'admin', 'registrar'];

async function requireImporter(
  trx: OrgTransaction,
  orgId: string,
  actorId: string,
  kind: ImportKind | null,
  impersonating: boolean,
): Promise<void> {
  if (impersonating) return;
  const roles = (kind && importRoles[kind]) ?? defaultImportRoles;
  const staff = await trx
    .selectFrom('org_memberships')
    .innerJoin('role_assignments', (join) =>
      join
        .onRef('role_assignments.org_id', '=', 'org_memberships.org_id')
        .onRef(
          'role_assignments.account_id',
          '=',
          'org_memberships.account_id',
        ),
    )
    .select('org_memberships.id')
    .where('org_memberships.org_id', '=', orgId)
    .where('org_memberships.account_id', '=', actorId)
    .where('org_memberships.status', '=', 'active')
    .where('role_assignments.role', 'in', roles)
    .where('role_assignments.scope_type', '=', 'org')
    .where('role_assignments.pending_mfa', '=', false)
    .where('role_assignments.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!staff)
    throw new ImportsError(404, 'NOT_FOUND', 'Organization not found');
}

function suggestColumns(
  headers: readonly string[],
  kind: ImportKind,
): { columns: Record<string, string | null>; unmatched: string[] } {
  const fields = importFields[kind];
  const columns: Record<string, string | null> = {};
  const used = new Set<string>();
  const normalizeHeader = (header: string) =>
    header
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, ' ')
      .trim();
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const compact = normalized.replaceAll(' ', '_');
    let match =
      fields.find(
        (candidate) =>
          !used.has(candidate.key) &&
          (candidate.key === compact ||
            candidate.label.toLowerCase() === normalized),
      ) ?? null;
    if (!match) {
      const headerTokens = new Set(normalized.split(' '));
      match =
        fields.find(
          (candidate) =>
            !used.has(candidate.key) &&
            candidate.aliases.some((alias) => {
              const tokens = alias.toLowerCase();
              return (
                tokens === normalized ||
                (tokens.split(' ').length > 1 &&
                  tokens.split(' ').every((token) => headerTokens.has(token)))
              );
            }),
        ) ?? null;
    }
    if (!match) {
      match =
        fields.find(
          (candidate) =>
            !used.has(candidate.key) &&
            normalized
              .split(' ')
              .every((token) =>
                candidate.label.toLowerCase().split(' ').includes(token),
              ),
        ) ?? null;
    }
    columns[header] = match ? match.key : null;
    if (match) used.add(match.key);
  }
  const required = new Set(
    fields.filter((entry) => entry.required).map((entry) => entry.key),
  );
  const unmatched = [...required].filter(
    (key) => !Object.values(columns).includes(key),
  );
  return { columns, unmatched };
}

function applyMapping(
  raw: Record<string, string>,
  mapping: ImportMapping,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [header, target] of Object.entries(mapping.columns)) {
    if (!target) continue;
    const value = raw[header];
    if (value === undefined) continue;
    values[target] = value;
  }
  return values;
}

interface RowRecord {
  id: string;
  row_number: number;
  raw: unknown;
  normalized: unknown;
  issues: unknown;
  action: string;
  target_id: string | null;
  target_version: number | null;
}

const DOCUMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export function createImportsService(
  database: Kysely<DB>,
  encryption: EncryptionKeys | null,
  storage: Storage | null = null,
) {
  const withOrg = createWithOrg(database);

  async function storeFile(
    trx: OrgTransaction,
    orgId: string,
    actorId: string,
    input: {
      name: string;
      mime: string;
      bytes: Uint8Array;
      purpose: string;
      ownerType?: string;
      ownerId?: string;
      sensitivity?: string;
    },
  ): Promise<string> {
    if (!storage)
      throw new ImportsError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'File storage is unavailable',
      );
    const extension = input.name.split('.').at(-1)?.toLowerCase() ?? 'bin';
    const key = createStorageKey(orgId, input.purpose, extension);
    await storage.put(key, Buffer.from(input.bytes), input.mime);
    const id = newId();
    await trx
      .insertInto('files')
      .values({
        id,
        org_id: orgId,
        purpose: input.purpose,
        ...(input.ownerType ? { owner_type: input.ownerType } : {}),
        ...(input.ownerId ? { owner_id: input.ownerId } : {}),
        storage_key: key,
        mime: input.mime,
        bytes: input.bytes.byteLength,
        sensitivity: input.sensitivity ?? 'internal',
        created_by: actorId,
        upload_state: 'complete',
      })
      .execute();
    return id;
  }

  async function loadDocuments(
    trx: OrgTransaction,
    orgId: string,
    fileId: string | null,
  ): Promise<Map<string, { bytes: Uint8Array; mime: string }> | undefined> {
    if (!fileId || !storage) return undefined;
    const file = await trx
      .selectFrom('files')
      .select(['storage_key'])
      .where('org_id', '=', orgId)
      .where('id', '=', fileId)
      .executeTakeFirst();
    if (!file) return undefined;
    const object = await storage.get(file.storage_key);
    if (!object || !isZip(object.bytes)) return undefined;
    const documents = new Map<string, { bytes: Uint8Array; mime: string }>();
    for (const entry of readZip(object.bytes)) {
      if (entry.directory || entry.name.toLowerCase().endsWith('.csv'))
        continue;
      const extension = entry.name.split('.').at(-1)?.toLowerCase() ?? '';
      const mime = DOCUMENT_MIME[extension];
      if (!mime) continue;
      const base = entry.name.split('/').at(-1) ?? entry.name;
      if (documents.has(base))
        throw new ImportsError(
          400,
          'VALIDATION_ERROR',
          `More than one zip entry is named ${base}`,
        );
      documents.set(base, {
        bytes: entry.bytes,
        mime,
      });
    }
    return documents;
  }

  function toBatch(
    row: {
      id: string;
      org_id: string;
      kind: string;
      file_name: string;
      file_bytes: number;
      mapping: unknown;
      mapping_preset_id: string | null;
      status: string;
      row_count: number;
      error_count: number;
      progress: unknown;
      summary: unknown;
      created_by: string;
      committed_at: Date | null;
      rolled_back_at: Date | null;
      created_at: Date;
    },
    extras: { headers?: string[]; sampleRows?: Record<string, string>[] } = {},
  ): ImportBatch {
    const stored = (row.summary ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      orgId: row.org_id,
      kind: row.kind as ImportKind,
      fileName: row.file_name,
      fileBytes: row.file_bytes,
      headers:
        extras.headers ?? (stored['headers'] as string[] | undefined) ?? [],
      sampleRows:
        extras.sampleRows ??
        (stored['sample'] as Record<string, string>[] | undefined) ??
        [],
      mapping: (row.mapping as ImportMapping | null) ?? null,
      mappingPresetId: row.mapping_preset_id,
      status: row.status as ImportBatch['status'],
      rowCount: row.row_count,
      errorCount: row.error_count,
      progress: row.progress as { processed: number; total: number },
      summary: (row.summary as Record<string, unknown> | null) ?? null,
      createdBy: row.created_by,
      committedAt: row.committed_at?.toISOString() ?? null,
      rolledBackAt: row.rolled_back_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    };
  }

  async function audit(
    trx: OrgTransaction,
    orgId: string,
    actorId: string,
    batchId: string,
    action: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: orgId,
        actor_account_id: actorId,
        action,
        entity_type: 'import_batch',
        entity_id: batchId,
        changes: JSON.parse(JSON.stringify(changes)) as JsonObject,
      })
      .execute();
  }

  async function notify(orgId: string, batchId: string): Promise<void> {
    await sql`SELECT pg_notify('import_progress', ${JSON.stringify({ orgId, batchId })})`.execute(
      database,
    );
  }

  return {
    async listBatches(
      orgId: string,
      actorId: string,
      impersonating = false,
    ): Promise<{ items: ImportBatch[] }> {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireImporter(trx, orgId, actorId, null, impersonating);
        const rows = await trx
          .selectFrom('phase15_import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .orderBy('created_at', 'desc')
          .limit(100)
          .execute();
        return { items: rows.map((row) => toBatch(row)) };
      });
    },

    async getBatch(
      orgId: string,
      actorId: string,
      batchId: string,
      impersonating = false,
    ): Promise<ImportBatch> {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireImporter(trx, orgId, actorId, null, impersonating);
        const row = await trx
          .selectFrom('phase15_import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!row) throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
        return toBatch(row);
      });
    },

    async progress(
      orgId: string,
      actorId: string,
      batchId: string,
      impersonating = false,
    ): Promise<{ status: string; processed: number; total: number }> {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireImporter(trx, orgId, actorId, null, impersonating);
        const row = await trx
          .selectFrom('phase15_import_batches')
          .select(['status', 'progress'])
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!row) throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
        const progress = row.progress as { processed: number; total: number };
        return {
          status: row.status,
          processed: progress.processed,
          total: progress.total,
        };
      });
    },

    async createBatch(
      orgId: string,
      actorId: string,
      input: { kind: ImportKind; fileName: string; bytes: Uint8Array },
      impersonating = false,
    ): Promise<ImportBatch> {
      await withOrg({ orgId, actor: { accountId: actorId } }, (trx) =>
        requireImporter(trx, orgId, actorId, input.kind, impersonating),
      );
      if (input.bytes.byteLength > MAX_IMPORT_BYTES)
        throw new ImportsError(
          413,
          'PAYLOAD_TOO_LARGE',
          'Import files must be 20 MB or smaller',
        );
      let table: ParsedTable;
      const zip = isZip(input.bytes) ? input.bytes : null;
      try {
        if (zip) {
          if (input.kind !== 'credentials')
            throw new ImportParseError(
              'ZIP archives are supported for credential imports only',
            );
          const csvEntries = readZip(zip).filter(
            (entry) =>
              !entry.directory && entry.name.toLowerCase().endsWith('.csv'),
          );
          if (csvEntries.length !== 1)
            throw new ImportParseError(
              'The credential zip archive must contain exactly one CSV file',
            );
          const csvEntry = csvEntries[0];
          if (!csvEntry)
            throw new ImportParseError('The zip archive has no CSV file');
          table = await parseImportFile(csvEntry.name, csvEntry.bytes);
        } else {
          table = await parseImportFile(input.fileName, input.bytes);
        }
      } catch (error) {
        if (error instanceof ImportParseError)
          throw new ImportsError(400, 'VALIDATION_ERROR', error.message);
        throw new ImportsError(
          400,
          'VALIDATION_ERROR',
          'The file could not be parsed as CSV or XLSX',
        );
      }
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireImporter(trx, orgId, actorId, input.kind, impersonating);
        const batchId = newId();
        let fileId: string | null = null;
        if (zip) {
          fileId = await storeFile(trx, orgId, actorId, {
            name: input.fileName,
            mime: 'application/zip',
            bytes: zip,
            purpose: 'import',
            ownerType: 'import_batch',
            ownerId: batchId,
            sensitivity: 'sensitive',
          });
        }
        const suggestion = suggestColumns(table.headers, input.kind);
        await trx
          .insertInto('phase15_import_batches')
          .values({
            id: batchId,
            org_id: orgId,
            kind: input.kind,
            file_id: fileId,
            file_name: input.fileName,
            file_bytes: input.bytes.byteLength,
            mapping: { columns: suggestion.columns },
            summary: {
              headers: table.headers,
              sample: table.rows.slice(0, 5),
              unmatchedTargets: suggestion.unmatched,
            },
            row_count: table.rows.length,
            created_by: actorId,
          })
          .execute();
        const chunkSize = 500;
        for (let start = 0; start < table.rows.length; start += chunkSize) {
          await trx
            .insertInto('phase15_import_rows')
            .values(
              table.rows.slice(start, start + chunkSize).map((raw, index) => ({
                id: newId(),
                org_id: orgId,
                batch_id: batchId,
                row_number: start + index + 1,
                raw,
              })),
            )
            .execute();
        }
        await audit(trx, orgId, actorId, batchId, 'import.created', {
          kind: input.kind,
          rows: table.rows.length,
        });
        const row = await trx
          .selectFrom('phase15_import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirstOrThrow();
        return toBatch(row, {
          headers: table.headers,
          sampleRows: table.rows.slice(0, 5),
        });
      });
    },

    async suggestMapping(
      orgId: string,
      actorId: string,
      batchId: string,
      impersonating = false,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireImporter(trx, orgId, actorId, null, impersonating);
        const batch = await trx
          .selectFrom('phase15_import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!batch)
          throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
        const summary = (batch.summary ?? {}) as Record<string, unknown>;
        const headers = (summary['headers'] as string[] | undefined) ?? [];
        const suggestion = suggestColumns(headers, batch.kind as ImportKind);
        return {
          mapping: { columns: suggestion.columns },
          unmatchedTargets: suggestion.unmatched,
        };
      });
    },

    async setMapping(
      orgId: string,
      actorId: string,
      batchId: string,
      mapping: ImportMapping,
      savePresetAs: string | undefined,
      impersonating = false,
    ): Promise<ImportBatch> {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        const batch = await trx
          .selectFrom('phase15_import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!batch)
          throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
        await requireImporter(
          trx,
          orgId,
          actorId,
          batch.kind as ImportKind,
          impersonating,
        );
        if (!['uploaded', 'mapped', 'validated'].includes(batch.status))
          throw new ImportsError(
            409,
            'CONFLICT',
            `Cannot change the mapping while the import is ${batch.status}`,
          );
        const fields = importFields[batch.kind as ImportKind];
        const targets = new Set(
          Object.values(mapping.columns).filter(Boolean) as string[],
        );
        const missing = fields
          .filter((field) => field.required && !targets.has(field.key))
          .map((field) => field.label);
        if (missing.length > 0)
          throw new ImportsError(
            400,
            'VALIDATION_ERROR',
            `Map the required columns first: ${missing.join(', ')}`,
          );
        const known = new Set(fields.map((field) => field.key));
        const unknown = [...targets].filter((target) => !known.has(target));
        if (unknown.length > 0)
          throw new ImportsError(
            400,
            'VALIDATION_ERROR',
            `Unknown target fields: ${unknown.join(', ')}`,
          );
        let presetId: string | null = null;
        if (savePresetAs) {
          presetId = newId();
          await trx
            .insertInto('phase15_import_mapping_presets')
            .values({
              id: presetId,
              org_id: orgId,
              kind: batch.kind,
              name: savePresetAs,
              mapping,
            })
            .execute();
        }
        await trx
          .updateTable('phase15_import_batches')
          .set({
            mapping,
            status: 'mapped',
            ...(presetId ? { mapping_preset_id: presetId } : {}),
          })
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .execute();
        await audit(trx, orgId, actorId, batchId, 'import.mapped', {});
        const row = await trx
          .selectFrom('phase15_import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirstOrThrow();
        return toBatch(row);
      });
    },

    async listPresets(
      orgId: string,
      actorId: string,
      kind: ImportKind | null,
      impersonating = false,
    ) {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireImporter(trx, orgId, actorId, null, impersonating);
        let statement = trx
          .selectFrom('phase15_import_mapping_presets')
          .selectAll()
          .where((eb) =>
            eb.or([eb('org_id', '=', orgId), eb('org_id', 'is', null)]),
          );
        if (kind) statement = statement.where('kind', '=', kind);
        const rows = await statement.orderBy('name').execute();
        return {
          items: rows.map((row) => ({
            id: row.id,
            orgId: row.org_id,
            kind: row.kind,
            name: row.name,
            mapping: row.mapping,
            builtin: row.builtin,
          })),
        };
      });
    },

    async listRows(
      orgId: string,
      actorId: string,
      batchId: string,
      query: {
        cursor?: string | undefined;
        limit: number;
        filter: 'all' | 'errors' | 'duplicates';
      },
      impersonating = false,
    ): Promise<{ items: ImportRow[]; nextCursor: string | null }> {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await requireImporter(trx, orgId, actorId, null, impersonating);
        const batch = await trx
          .selectFrom('phase15_import_batches')
          .select(['id'])
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!batch)
          throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
        let statement = trx
          .selectFrom('phase15_import_rows')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('batch_id', '=', batchId);
        if (query.filter === 'errors')
          statement = statement.where(
            sql<boolean>`jsonb_array_length(issues) > 0 AND issues::text LIKE '%"level":"error"%'`,
          );
        if (query.filter === 'duplicates')
          statement = statement.where(
            sql<boolean>`jsonb_array_length(duplicates) > 0`,
          );
        if (query.cursor) {
          const cursor = Number(query.cursor);
          if (Number.isInteger(cursor) && cursor > 0)
            statement = statement.where('row_number', '>', cursor);
        }
        const rows = await statement
          .orderBy('row_number')
          .limit(query.limit + 1)
          .execute();
        const page = rows.slice(0, query.limit);
        const nextCursor =
          rows.length > query.limit
            ? String(page.at(-1)?.row_number ?? '')
            : null;
        return {
          items: page.map((row) => ({
            id: row.id,
            rowNumber: row.row_number,
            raw: row.raw as Record<string, string>,
            normalized:
              (row.normalized as Record<string, unknown> | null) ?? null,
            issues: row.issues as ImportIssue[],
            duplicates: row.duplicates as ImportRow['duplicates'],
            action: row.action as ImportRow['action'],
            targetId: row.target_id,
          })),
          nextCursor,
        };
      });
    },

    async skipAllDuplicates(
      orgId: string,
      batchId: string,
      actorId: string,
    ): Promise<{ skipped: number }> {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        const batch = await trx
          .selectFrom('phase15_import_batches')
          .select(['id', 'kind', 'status'])
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!batch)
          throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
        await requireImporter(
          trx,
          orgId,
          actorId,
          batch.kind as ImportKind,
          false,
        );
        if (batch.status !== 'validated')
          throw new ImportsError(
            409,
            'CONFLICT',
            'Review duplicate rows after validation',
          );
        const result = await sql<{ id: string }>`
          UPDATE phase15_import_rows
          SET action = 'skip', target_id = NULL
          WHERE org_id = ${orgId} AND batch_id = ${batchId}
            AND jsonb_array_length(duplicates) > 0
          RETURNING id
        `.execute(trx);
        await audit(trx, orgId, actorId, batchId, 'import.duplicates_skipped', {
          rows: result.rows.length,
        });
        return { skipped: result.rows.length };
      });
    },

    async validateBatch(
      orgId: string,
      batchId: string,
      actorId: string,
      documents?: Map<string, { bytes: Uint8Array; mime: string }>,
    ): Promise<{ rowCount: number; errorCount: number }> {
      const loaded = await withOrg(
        { orgId, actor: { accountId: actorId } },
        async (trx) => {
          const found = await trx
            .selectFrom('phase15_import_batches')
            .selectAll()
            .where('org_id', '=', orgId)
            .where('id', '=', batchId)
            .executeTakeFirst();
          if (!found)
            throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
          await requireImporter(
            trx,
            orgId,
            actorId,
            found.kind as ImportKind,
            false,
          );
          if (
            ![
              'uploaded',
              'mapped',
              'validated',
              'failed',
              'validating',
            ].includes(found.status)
          )
            throw new ImportsError(
              409,
              'CONFLICT',
              `Cannot validate an import while it is ${found.status}`,
            );
          const storedDocuments = await loadDocuments(
            trx,
            orgId,
            found.file_id,
          );
          await trx
            .updateTable('phase15_import_batches')
            .set({
              status: 'validating',
              progress: { processed: 0, total: found.row_count },
            })
            .where('org_id', '=', orgId)
            .where('id', '=', batchId)
            .execute();
          return { batch: found, storedDocuments };
        },
      );
      await notify(orgId, batchId);
      const { batch } = loaded;
      const validationDocuments = documents ?? loaded.storedDocuments;
      const kind = batch.kind as ImportKind;
      const mapping = batch.mapping as ImportMapping;
      const definition = importKinds[kind];
      let processed = 0;
      let errorCount = 0;
      const chunkSize = 200;
      for (let offset = 0; ; offset += chunkSize) {
        const done = await withOrg(
          { orgId, actor: { accountId: actorId } },
          async (trx) => {
            const rows = (await trx
              .selectFrom('phase15_import_rows')
              .selectAll()
              .where('org_id', '=', orgId)
              .where('batch_id', '=', batchId)
              .orderBy('row_number')
              .offset(offset)
              .limit(chunkSize)
              .execute()) as RowRecord[];
            if (rows.length === 0) return true;
            const ctx: CommitContext = {
              orgId,
              actorId,
              encryption,
              ...(validationDocuments
                ? { documents: validationDocuments }
                : {}),
            };
            const duplicateStrategy =
              mapping.options?.duplicateStrategy ?? 'ask';
            for (const row of rows) {
              const values = applyMapping(
                row.raw as Record<string, string>,
                mapping,
              );
              const { normalized, issues, duplicates } =
                await definition.normalize(trx, ctx, values);
              const hasError = issues.some((entry) => entry.level === 'error');
              if (hasError) errorCount += 1;
              let action = row.action;
              if (duplicates.length > 0 && duplicateStrategy === 'skip_all')
                action = 'skip';
              else if (duplicates.length > 0 && kind === 'people')
                action = 'skip';
              await trx
                .updateTable('phase15_import_rows')
                .set({
                  normalized: normalized as JsonObject,
                  issues: JSON.stringify(issues),
                  duplicates: JSON.stringify(duplicates),
                  action: hasError ? 'skip' : action,
                  ...(duplicates[0] && action === 'update'
                    ? { target_id: duplicates[0].personId }
                    : {}),
                })
                .where('org_id', '=', orgId)
                .where('id', '=', row.id)
                .execute();
            }
            processed += rows.length;
            await trx
              .updateTable('phase15_import_batches')
              .set({ progress: { processed, total: batch.row_count } })
              .where('org_id', '=', orgId)
              .where('id', '=', batchId)
              .execute();
            return false;
          },
        );
        await notify(orgId, batchId);
        if (done) break;
      }
      await withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        await trx
          .updateTable('phase15_import_batches')
          .set({
            status: 'validated',
            error_count: errorCount,
            progress: { processed, total: batch.row_count },
          })
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .execute();
        await audit(trx, orgId, actorId, batchId, 'import.validated', {
          errors: errorCount,
        });
      });
      await notify(orgId, batchId);
      return { rowCount: batch.row_count, errorCount };
    },

    async decideRows(
      orgId: string,
      actorId: string,
      batchId: string,
      decisions: { rowId: string; action: 'create' | 'skip' }[],
      impersonating = false,
    ): Promise<{ updated: number }> {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        const batch = await trx
          .selectFrom('phase15_import_batches')
          .select(['id', 'kind', 'status'])
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!batch)
          throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
        await requireImporter(
          trx,
          orgId,
          actorId,
          batch.kind as ImportKind,
          impersonating,
        );
        if (batch.status !== 'validated')
          throw new ImportsError(
            409,
            'CONFLICT',
            'Row decisions are only available after validation',
          );
        const seen = new Set<string>();
        for (const decision of decisions) {
          if (seen.has(decision.rowId))
            throw new ImportsError(
              400,
              'VALIDATION_ERROR',
              'A row can only appear once per decision',
            );
          seen.add(decision.rowId);
          const row = await trx
            .selectFrom('phase15_import_rows')
            .select(['id', 'issues', 'duplicates'])
            .where('org_id', '=', orgId)
            .where('batch_id', '=', batchId)
            .where('id', '=', decision.rowId)
            .executeTakeFirst();
          if (!row)
            throw new ImportsError(404, 'NOT_FOUND', 'Import row not found');
          const issues = row.issues as ImportIssue[];
          const hasError = issues.some((entry) => entry.level === 'error');
          if (hasError && decision.action !== 'skip')
            throw new ImportsError(
              400,
              'VALIDATION_ERROR',
              'Rows with validation errors must be skipped',
            );
          const duplicates = row.duplicates as ImportDuplicate[];
          if (decision.action === 'create' && duplicates.length === 0)
            throw new ImportsError(
              400,
              'VALIDATION_ERROR',
              'Only duplicate rows can be changed to create',
            );
          await trx
            .updateTable('phase15_import_rows')
            .set({
              action: decision.action,
              target_id: null,
            })
            .where('org_id', '=', orgId)
            .where('id', '=', row.id)
            .execute();
        }
        await audit(trx, orgId, actorId, batchId, 'import.rows_decided', {
          rows: decisions.length,
        });
        return { updated: decisions.length };
      });
    },

    async commitBatch(
      orgId: string,
      batchId: string,
      actorId: string,
      ctx?: Partial<CommitContext>,
    ): Promise<Record<string, unknown>> {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        const batch = await trx
          .selectFrom('phase15_import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!batch)
          throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
        await requireImporter(
          trx,
          orgId,
          actorId,
          batch.kind as ImportKind,
          false,
        );
        if (batch.status !== 'validated' && batch.status !== 'committing')
          throw new ImportsError(
            409,
            'CONFLICT',
            `Cannot commit an import while it is ${batch.status}`,
          );
        await trx
          .updateTable('phase15_import_batches')
          .set({ status: 'committing' })
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .execute();
        const kind = batch.kind as ImportKind;
        const rows = (await trx
          .selectFrom('phase15_import_rows')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('batch_id', '=', batchId)
          .orderBy('row_number')
          .execute()) as RowRecord[];
        const pending = rows.filter((row) => {
          const issues = row.issues as ImportIssue[];
          return (
            row.action !== 'skip' &&
            !issues.some((entry) => entry.level === 'error')
          );
        });
        const context: CommitContext = {
          orgId,
          actorId,
          encryption,
          documents: await loadDocuments(trx, orgId, batch.file_id),
          createFile: async (file) =>
            storeFile(trx, orgId, actorId, {
              name: file.name,
              mime: file.mime,
              bytes: file.bytes,
              purpose: 'document',
              ownerType: file.ownerType,
              ownerId: file.ownerId,
              sensitivity: 'sensitive',
            }),
          ...ctx,
        };
        const { outcomes, summary } = await importKinds[kind].commit(
          trx,
          context,
          pending.map((row) => ({
            rowId: row.id,
            normalized:
              (row.normalized as Record<string, unknown> | null) ?? {},
            action: row.action,
            targetId: row.target_id,
          })),
        );
        let committed = 0;
        for (const row of pending) {
          const outcome = outcomes.get(row.id);
          const primary = outcome?.targets[0];
          await trx
            .updateTable('phase15_import_rows')
            .set({
              target_id: primary?.id ?? null,
              target_version: primary?.version ?? null,
              normalized: {
                ...((row.normalized as Record<string, unknown> | null) ?? {}),
                _targets: outcome?.targets ?? [],
              },
            })
            .where('org_id', '=', orgId)
            .where('id', '=', row.id)
            .execute();
          if (primary) committed += 1;
        }
        await trx
          .updateTable('phase15_import_batches')
          .set({
            status: 'committed',
            committed_at: new Date(),
            summary: {
              ...((batch.summary as Record<string, unknown> | null) ?? {}),
              ...summary,
              committed,
              total: rows.length,
            },
          })
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .execute();
        await audit(trx, orgId, actorId, batchId, 'import.committed', {
          committed,
          ...summary,
        });
        return { committed, total: rows.length, ...summary };
      });
    },

    async rollbackBatch(
      orgId: string,
      batchId: string,
      actorId: string,
      impersonating = false,
    ): Promise<Record<string, unknown>> {
      return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        const batch = await trx
          .selectFrom('phase15_import_batches')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!batch)
          throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
        await requireImporter(
          trx,
          orgId,
          actorId,
          batch.kind as ImportKind,
          impersonating,
        );
        if (batch.status !== 'committed')
          throw new ImportsError(
            409,
            'CONFLICT',
            'Only a committed import can be rolled back',
          );
        const rows = (await trx
          .selectFrom('phase15_import_rows')
          .selectAll()
          .where('org_id', '=', orgId)
          .where('batch_id', '=', batchId)
          .orderBy('row_number', 'desc')
          .execute()) as RowRecord[];
        const deleted: Record<string, number> = {};
        const reversed: Record<string, number> = {};
        const retained: Record<string, number> = {};
        let skippedTouched = 0;
        const order = [
          'payment_allocations',
          'payments',
          'invoices',
          'invoice_lines',
          'volunteer_signups',
          'volunteer_shifts',
          'volunteer_roles',
          'person_credentials',
          'files',
          'event_participants',
          'events',
          'external_teams',
          'roster_entries',
          'team_staff',
          'team_seasons',
          'teams',
          'registrations',
          'emergency_contacts',
          'household_members',
          'households',
          'spaces',
          'facilities',
          'people',
        ];
        const pendingDeletes: {
          table: string;
          id: string;
          version: number | null;
        }[] = [];
        for (const row of rows) {
          const targets =
            ((row.normalized as Record<string, unknown> | null)?.[
              '_targets'
            ] as
              | { table: string; id: string; version: number | null }[]
              | undefined) ??
            (row.target_id
              ? [
                  {
                    table: 'people',
                    id: row.target_id,
                    version: row.target_version,
                  },
                ]
              : []);
          pendingDeletes.push(...targets);
        }
        pendingDeletes.sort(
          (a, b) => order.indexOf(a.table) - order.indexOf(b.table),
        );
        for (const target of pendingDeletes) {
          if (!order.includes(target.table)) continue;
          let result: { rows: { id: string }[] };
          if (target.table === 'files') {
            result = await sql<{ id: string }>`
                  UPDATE files SET deleted_at = now()
                  WHERE org_id = ${orgId} AND id = ${target.id}
                    AND deleted_at IS NULL
                  RETURNING id
                `.execute(trx);
          } else if (target.table === 'payments') {
            result = await sql<{ id: string }>`
              UPDATE payments
              SET status = 'canceled', version = version + 1
              WHERE org_id = ${orgId} AND id = ${target.id}
                AND version = ${target.version}
                AND method = 'external' AND status = 'succeeded'
              RETURNING id
            `.execute(trx);
            if (result.rows.length > 0)
              reversed['payments'] = (reversed['payments'] ?? 0) + 1;
          } else if (target.table === 'invoices') {
            result = await sql<{ id: string }>`
              UPDATE invoices
              SET status = 'void', paid_cents = 0, voided_at = now(),
                void_reason = ${`Historical import ${batchId} rolled back`},
                version = version + 1
              WHERE org_id = ${orgId} AND id = ${target.id}
                AND version = ${target.version}
                AND status = 'paid' AND paid_cents = total_cents
              RETURNING id
            `.execute(trx);
            if (result.rows.length > 0)
              reversed['invoices'] = (reversed['invoices'] ?? 0) + 1;
          } else if (target.table === 'person_credentials') {
            result = await sql<{ id: string }>`
              UPDATE person_credentials
              SET status = 'revoked', verified_by = NULL, verified_at = NULL,
                version = version + 1
              WHERE org_id = ${orgId} AND id = ${target.id}
                AND version = ${target.version}
                AND status IN ('pending_review', 'verified', 'rejected', 'expired')
              RETURNING id
            `.execute(trx);
            if (result.rows.length > 0)
              reversed['person_credentials'] =
                (reversed['person_credentials'] ?? 0) + 1;
          } else if (target.table === 'volunteer_signups') {
            result = await sql<{ id: string }>`
              UPDATE volunteer_signups
              SET status = 'canceled', version = version + 1
              WHERE org_id = ${orgId} AND id = ${target.id}
                AND version = ${target.version}
                AND status IN ('signed_up', 'confirmed', 'checked_in', 'completed', 'no_show')
              RETURNING id
            `.execute(trx);
            if (result.rows.length > 0)
              reversed['volunteer_signups'] =
                (reversed['volunteer_signups'] ?? 0) + 1;
          } else if (target.table === 'volunteer_shifts') {
            result = await sql<{ id: string }>`
              UPDATE volunteer_shifts
              SET status = 'canceled', version = version + 1
              WHERE org_id = ${orgId} AND id = ${target.id}
                AND version = ${target.version} AND status = 'completed'
              RETURNING id
            `.execute(trx);
            if (result.rows.length > 0)
              reversed['volunteer_shifts'] =
                (reversed['volunteer_shifts'] ?? 0) + 1;
          } else if (target.table === 'volunteer_roles') {
            result = await sql<{ id: string }>`
              UPDATE volunteer_roles AS role
              SET archived_at = now(), version = version + 1
              WHERE role.org_id = ${orgId} AND role.id = ${target.id}
                AND role.version = ${target.version} AND role.archived_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM volunteer_shifts AS shift
                  WHERE shift.org_id = role.org_id
                    AND shift.volunteer_role_id = role.id
                    AND shift.status <> 'canceled'
                )
              RETURNING id
            `.execute(trx);
            if (result.rows.length > 0) {
              reversed['volunteer_roles'] =
                (reversed['volunteer_roles'] ?? 0) + 1;
            } else {
              result = await sql<{ id: string }>`
                SELECT id FROM volunteer_roles
                WHERE org_id = ${orgId} AND id = ${target.id}
              `.execute(trx);
              if (result.rows.length > 0)
                retained['volunteer_roles'] =
                  (retained['volunteer_roles'] ?? 0) + 1;
            }
          } else if (target.table === 'registrations') {
            result = await sql<{ id: string }>`
            UPDATE registrations
            SET status = 'withdrawn',
              status_reason = ${`Import ${batchId} rolled back`},
              version = version + 1
            WHERE org_id = ${orgId} AND id = ${target.id}
              AND version = ${target.version}
            RETURNING id
          `.execute(trx);
            if (result.rows.length > 0)
              reversed['registrations'] = (reversed['registrations'] ?? 0) + 1;
          } else if (target.table === 'teams') {
            result = await sql<{ id: string }>`
            UPDATE teams SET status = 'retired', version = version + 1
            WHERE org_id = ${orgId} AND id = ${target.id}
              AND version = ${target.version} AND status = 'active'
            RETURNING id
          `.execute(trx);
            if (result.rows.length > 0)
              reversed['teams'] = (reversed['teams'] ?? 0) + 1;
          } else if (target.table === 'team_seasons') {
            result = await sql<{ id: string }>`
            UPDATE team_seasons SET status = 'withdrawn', version = version + 1
            WHERE org_id = ${orgId} AND id = ${target.id}
              AND version = ${target.version}
              AND status IN ('forming', 'active')
            RETURNING id
          `.execute(trx);
            if (result.rows.length > 0)
              reversed['team_seasons'] = (reversed['team_seasons'] ?? 0) + 1;
          } else if (target.table === 'roster_entries') {
            result = await sql<{ id: string }>`
            UPDATE roster_entries
            SET status = 'released', left_on = CURRENT_DATE,
              version = version + 1
            WHERE org_id = ${orgId} AND id = ${target.id}
              AND version = ${target.version}
              AND status IN ('active', 'injured', 'suspended', 'inactive')
            RETURNING id
          `.execute(trx);
            if (result.rows.length > 0)
              reversed['roster_entries'] =
                (reversed['roster_entries'] ?? 0) + 1;
          } else if (target.table === 'team_staff') {
            result = await sql<{ id: string }>`
            UPDATE team_staff SET status = 'removed', version = version + 1
            WHERE org_id = ${orgId} AND id = ${target.id}
              AND version = ${target.version} AND status <> 'removed'
            RETURNING id
          `.execute(trx);
            if (result.rows.length > 0)
              reversed['team_staff'] = (reversed['team_staff'] ?? 0) + 1;
          } else if (
            target.table === 'facilities' ||
            target.table === 'spaces'
          ) {
            result = await sql<{ id: string }>`
            UPDATE ${sql.table(target.table)} SET archived_at = now(),
              version = version + 1
            WHERE org_id = ${orgId} AND id = ${target.id}
              AND version = ${target.version} AND archived_at IS NULL
            RETURNING id
          `.execute(trx);
            if (result.rows.length > 0)
              reversed[target.table] = (reversed[target.table] ?? 0) + 1;
          } else if (target.table === 'events') {
            result = await sql<{ id: string }>`
            UPDATE events SET status = 'canceled', published = false,
              status_reason = ${`Import ${batchId} rolled back`},
              version = version + 1
            WHERE org_id = ${orgId} AND id = ${target.id}
              AND version = ${target.version}
              AND status IN ('scheduled', 'postponed')
            RETURNING id
          `.execute(trx);
            if (result.rows.length > 0)
              reversed['events'] = (reversed['events'] ?? 0) + 1;
          } else if (target.table === 'people') {
            result = await sql<{ id: string }>`
            UPDATE people SET status = 'archived', version = version + 1
            WHERE org_id = ${orgId} AND id = ${target.id}
              AND version = ${target.version} AND status = 'active'
            RETURNING id
          `.execute(trx);
            if (result.rows.length > 0)
              reversed['people'] = (reversed['people'] ?? 0) + 1;
          } else if (target.table === 'households') {
            result = await sql<{ id: string }>`
              UPDATE households
              SET status = 'archived', version = version + 1
              WHERE org_id = ${orgId} AND id = ${target.id}
                AND version = ${target.version} AND status = 'active'
              RETURNING id
            `.execute(trx);
            if (result.rows.length > 0)
              reversed['households'] = (reversed['households'] ?? 0) + 1;
          } else if (
            target.table === 'household_members' ||
            target.table === 'emergency_contacts'
          ) {
            result = await sql<{ id: string }>`
              SELECT id FROM ${sql.table(target.table)}
              WHERE org_id = ${orgId} AND id = ${target.id}
            `.execute(trx);
            if (result.rows.length > 0)
              retained[target.table] = (retained[target.table] ?? 0) + 1;
          } else if (
            target.table === 'payment_allocations' ||
            target.table === 'invoice_lines'
          ) {
            result = await sql<{ id: string }>`
              SELECT id FROM ${sql.table(target.table)}
              WHERE org_id = ${orgId} AND id = ${target.id}
            `.execute(trx);
            if (result.rows.length > 0)
              retained[target.table] = (retained[target.table] ?? 0) + 1;
          } else {
            result = await sql<{ id: string }>`
              SELECT id FROM ${sql.table(target.table)}
              WHERE org_id = ${orgId} AND id = ${target.id}
            `.execute(trx);
            if (result.rows.length > 0)
              retained[target.table] = (retained[target.table] ?? 0) + 1;
          }
          const specialTarget = [
            'payments',
            'invoices',
            'person_credentials',
            'payment_allocations',
            'invoice_lines',
            'households',
            'household_members',
            'emergency_contacts',
            'files',
            'registrations',
            'teams',
            'team_seasons',
            'roster_entries',
            'team_staff',
            'facilities',
            'spaces',
            'events',
            'people',
            'external_teams',
            'event_participants',
            'volunteer_roles',
            'volunteer_shifts',
            'volunteer_signups',
          ].includes(target.table);
          if (result.rows.length > 0 && !specialTarget) {
            deleted[target.table] = (deleted[target.table] ?? 0) + 1;
          } else if (result.rows.length === 0) {
            skippedTouched += 1;
          }
        }
        if (batch.file_id) {
          const archivedUpload = await sql<{ id: string }>`
            UPDATE files SET deleted_at = now()
            WHERE org_id = ${orgId} AND id = ${batch.file_id}
              AND deleted_at IS NULL
            RETURNING id
          `.execute(trx);
          if (archivedUpload.rows.length > 0)
            deleted['files'] = (deleted['files'] ?? 0) + 1;
        }
        await trx
          .updateTable('phase15_import_batches')
          .set({
            status: 'rolled_back',
            rolled_back_at: new Date(),
            summary: {
              ...((batch.summary as Record<string, unknown> | null) ?? {}),
              deleted,
              reversed,
              retained_records: retained,
              skipped_touched: skippedTouched,
            },
          })
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .execute();
        await audit(trx, orgId, actorId, batchId, 'import.rolled_back', {
          deleted,
          reversed,
          retained_records: retained,
          skipped_touched: skippedTouched,
        });
        return {
          deleted,
          reversed,
          retained_records: retained,
          skipped_touched: skippedTouched,
        };
      });
    },

    async enqueueProcessing(
      orgId: string,
      batchId: string,
      actorId: string,
      step: 'validate' | 'commit',
    ): Promise<void> {
      await withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
        const batch = await trx
          .selectFrom('phase15_import_batches')
          .select(['id', 'kind', 'status', 'mapping', 'row_count'])
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .executeTakeFirst();
        if (!batch)
          throw new ImportsError(404, 'NOT_FOUND', 'Import not found');
        await requireImporter(
          trx,
          orgId,
          actorId,
          batch.kind as ImportKind,
          false,
        );
        const allowed =
          step === 'validate'
            ? ['uploaded', 'mapped', 'validated', 'failed'].includes(
                batch.status,
              ) && batch.mapping !== null
            : batch.status === 'validated';
        if (!allowed)
          throw new ImportsError(
            409,
            'CONFLICT',
            `Cannot ${step} this import while it is ${batch.status}`,
          );
        await trx
          .updateTable('phase15_import_batches')
          .set({
            status: step === 'validate' ? 'validating' : 'committing',
            ...(step === 'validate'
              ? { progress: { processed: 0, total: batch.row_count } }
              : {}),
          })
          .where('org_id', '=', orgId)
          .where('id', '=', batchId)
          .execute();
      });
      await sql`
        INSERT INTO pgboss.job (name, data)
        VALUES ('imports.process', ${JSON.stringify({ orgId, batchId, actorId, step })}::jsonb)
      `.execute(database);
    },

    importFields,
  };
}

export type ImportsService = ReturnType<typeof createImportsService>;
