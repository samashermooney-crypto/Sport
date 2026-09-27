import { newId } from '@shared/ids';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';

import type { DB } from '../../db/types';
import type { Json } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { decryptRestricted, encryptRestricted } from '../crypto';
import type { EncryptionKeys } from '../crypto';

const maintenanceActorId = '00000000-0000-0000-0000-000000000000';

type Scope = 'organization' | 'tenant' | 'global';
interface EncryptedColumn {
  table: keyof DB;
  column: string;
  scope: Scope;
}

// Keep this list aligned with the bytea *_enc columns in db/migrations. These
// identifiers are source constants; all data values remain bound parameters.
const encryptedColumns: readonly EncryptedColumn[] = [
  { table: 'organizations', column: 'ein_enc', scope: 'organization' },
  { table: 'mfa_factors', column: 'secret_enc', scope: 'global' },
  { table: 'household_members', column: 'custody_note_enc', scope: 'tenant' },
  { table: 'medical_profiles', column: 'allergies_enc', scope: 'tenant' },
  { table: 'medical_profiles', column: 'conditions_enc', scope: 'tenant' },
  { table: 'medical_profiles', column: 'medications_enc', scope: 'tenant' },
  { table: 'medical_profiles', column: 'physician_name_enc', scope: 'tenant' },
  { table: 'medical_profiles', column: 'physician_phone_enc', scope: 'tenant' },
  {
    table: 'medical_profiles',
    column: 'insurance_carrier_enc',
    scope: 'tenant',
  },
  {
    table: 'medical_profiles',
    column: 'insurance_policy_enc',
    scope: 'tenant',
  },
  { table: 'medical_profiles', column: 'notes_enc', scope: 'tenant' },
  { table: 'form_responses', column: 'answers_enc', scope: 'tenant' },
  { table: 'person_credentials', column: 'identifier_enc', scope: 'tenant' },
  {
    table: 'background_check_orders',
    column: 'details_enc',
    scope: 'tenant',
  },
  { table: 'injury_reports', column: 'description_enc', scope: 'tenant' },
  { table: 'incident_reports', column: 'narrative_enc', scope: 'tenant' },
  { table: 'incident_reports', column: 'resolution_enc', scope: 'tenant' },
  {
    table: 'background_check_adjudication_events',
    column: 'reason_enc',
    scope: 'tenant',
  },
  {
    table: 'background_check_disputes',
    column: 'statement_enc',
    scope: 'tenant',
  },
  {
    table: 'background_check_disputes',
    column: 'resolution_enc',
    scope: 'tenant',
  },
];

export interface EncryptionRotationOptions {
  batchSize?: number;
  dryRun?: boolean;
}

export interface EncryptionRotationSummary {
  dryRun: boolean;
  rowsExamined: number;
  rowsNeedingRotation: number;
  rowsRotated: number;
}

interface EncryptedRow {
  id: string;
  ciphertext: Buffer;
}

function embeddedKeyId(value: Buffer): string | null {
  const size = value[0];
  if (size === undefined || size === 0 || value.length < 1 + size) return null;
  return value.subarray(1, 1 + size).toString('utf8');
}

function organizationContext(orgId: string): OrgContext {
  return { orgId, actor: { accountId: maintenanceActorId } };
}

async function rotateColumn(
  database: Kysely<DB>,
  withOrg: ReturnType<typeof createWithOrg>,
  column: EncryptedColumn,
  orgId: string | null,
  encryption: EncryptionKeys,
  batchSize: number,
  dryRun: boolean,
  summary: EncryptionRotationSummary,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(column.column))
    throw new Error('Unsafe encryption column name');
  if (column.scope !== 'global' && !orgId)
    throw new Error('Organization context is required');

  const processBatch = async (
    trx: OrgTransaction | Transaction<DB>,
    afterId: string | null,
  ): Promise<string | null> => {
    const organizationFilter =
      column.scope === 'tenant'
        ? sql`and org_id = ${orgId}`
        : column.scope === 'organization'
          ? sql`and id = ${orgId}`
          : sql``;
    const cursorFilter = afterId ? sql`and id > ${afterId}` : sql``;
    const { rows } = await sql<EncryptedRow>`
      select id::text as id, ${sql.ref(column.column)} as ciphertext
      from ${sql.table(column.table)}
      where ${sql.ref(column.column)} is not null
        ${organizationFilter}
        ${cursorFilter}
      order by id
      limit ${batchSize}
      for update
    `.execute(trx);

    for (const row of rows) {
      summary.rowsExamined += 1;
      if (embeddedKeyId(row.ciphertext) === encryption.activeKid) continue;
      summary.rowsNeedingRotation += 1;
      const plaintext = decryptRestricted(row.ciphertext, encryption);
      if (dryRun) continue;
      const replacement = encryptRestricted(plaintext, encryption);
      const rowScopeFilter =
        column.scope === 'tenant'
          ? sql`and org_id = ${orgId}`
          : column.scope === 'organization'
            ? sql`and id = ${orgId}`
            : sql``;
      await sql`
        update ${sql.table(column.table)}
        set ${sql.ref(column.column)} = ${replacement}
        where id = ${row.id}
          ${rowScopeFilter}
      `.execute(trx);
      if (column.scope === 'global') {
        await trx
          .insertInto('security_events')
          .values({
            id: newId(),
            account_id: null,
            action: 'encryption.key_rotated',
            details: {
              entityId: row.id,
              entityType: column.table,
              keyIdBefore: embeddedKeyId(row.ciphertext),
              keyIdAfter: encryption.activeKid,
            },
          })
          .execute();
      } else {
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: orgId,
            actor_account_id: null,
            action: 'encryption.key_rotated',
            entity_type: column.table,
            entity_id: row.id,
            changes: {
              encryptionKeyId: {
                tier: 'internal',
                before: embeddedKeyId(row.ciphertext) ?? 'unknown',
                after: encryption.activeKid,
              },
            } as Json,
          })
          .execute();
      }
      summary.rowsRotated += 1;
    }
    return rows.length > 0 ? (rows.at(-1)?.id ?? null) : null;
  };

  let afterId: string | null = null;
  for (;;) {
    const next =
      column.scope === 'global'
        ? await database
            .transaction()
            .execute((trx) => processBatch(trx, afterId))
        : await withOrg(organizationContext(orgId ?? ''), (trx) =>
            processBatch(trx, afterId),
          );
    if (!next) break;
    afterId = next;
  }
}

/**
 * Re-encrypts every known Restricted bytea field using the active key. Tenant
 * fields use withOrg transactions and bounded batches. Only the global MFA
 * factor table is read outside withOrg because it has no tenant owner.
 */
export async function rotateEncryptedData(
  database: Kysely<DB>,
  encryption: EncryptionKeys,
  options: EncryptionRotationOptions = {},
): Promise<EncryptionRotationSummary> {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new RangeError('Encryption rotation batch size must be 1–1000');
  const dryRun = options.dryRun ?? true;
  const summary: EncryptionRotationSummary = {
    dryRun,
    rowsExamined: 0,
    rowsNeedingRotation: 0,
    rowsRotated: 0,
  };
  const withOrg = createWithOrg(database);
  // `linked_org_ids` is a global candidate index, not authorization. Resolve
  // every candidate withOrg below before reading or changing tenant data.
  const accountIndexes = await database
    .selectFrom('accounts')
    .select('linked_org_ids')
    .execute();
  const organizations = [
    ...new Set(accountIndexes.flatMap((row) => row.linked_org_ids)),
  ].sort();

  for (const column of encryptedColumns) {
    if (column.scope === 'global') {
      await rotateColumn(
        database,
        withOrg,
        column,
        null,
        encryption,
        batchSize,
        dryRun,
        summary,
      );
      continue;
    }
    for (const orgId of organizations) {
      await rotateColumn(
        database,
        withOrg,
        column,
        orgId,
        encryption,
        batchSize,
        dryRun,
        summary,
      );
    }
  }
  return summary;
}
