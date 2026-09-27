import { federationSharingSchema } from '@shared/schemas/federation';
import type {
  FederationRelationshipType,
  FederationSharing,
  FederationSharingKey,
} from '@shared/schemas/federation';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import type { OrgContext } from '../../db/withOrg';
import type { AuditChanges } from '../audit/redaction';
import { appendAuditEvent } from '../audit/service';

import {
  FederationError,
  federationNotFound,
  federationUnavailable,
} from './errors';

let federationAdminDatabase: Kysely<DB> | undefined;

/**
 * The admin connection bypasses RLS (athlentry_admin is BYPASSRLS). Every query
 * issued through it MUST carry explicit org filters — the privileged service is
 * the only place this connection is used for tenant data, and every access path
 * asserts the relationship + sharing allow-list before running allow-listed
 * queries.
 */
export function getFederationAdminDatabase(): Kysely<DB> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url)
    throw federationUnavailable(
      'Federation access requires DATABASE_ADMIN_URL',
    );
  federationAdminDatabase ??= createDatabase(url);
  return federationAdminDatabase;
}

export function resetFederationAdminDatabase(): void {
  federationAdminDatabase = undefined;
}

export interface FederationRelationshipRow {
  id: string;
  parent_org_id: string;
  child_org_id: string;
  type: string;
  initiator: string;
  status: string;
  data_sharing: unknown;
  pending_data_sharing: unknown;
  version: number;
}

export interface ActiveRelationship {
  id: string;
  parentOrgId: string;
  childOrgId: string;
  type: FederationRelationshipType;
  dataSharing: FederationSharing;
  version: number;
}

export async function findRelationship(
  trx: Transaction<DB>,
  orgAId: string,
  orgBId: string,
): Promise<FederationRelationshipRow | undefined> {
  return trx
    .selectFrom('org_relationships')
    .select([
      'id',
      'parent_org_id',
      'child_org_id',
      'type',
      'initiator',
      'status',
      'data_sharing',
      'pending_data_sharing',
      'version',
    ])
    .where((eb) =>
      eb.or([
        eb.and({ parent_org_id: orgAId, child_org_id: orgBId }),
        eb.and({ parent_org_id: orgBId, child_org_id: orgAId }),
      ]),
    )
    .where('status', 'in', ['invited', 'active', 'suspended'])
    .executeTakeFirst();
}

/** Parent-org view: relationship must be active and orgIds must be parent→child. */
export async function assertActiveRelationship(
  trx: Transaction<DB>,
  parentOrgId: string,
  childOrgId: string,
): Promise<ActiveRelationship> {
  const row = await trx
    .selectFrom('org_relationships')
    .select([
      'id',
      'parent_org_id',
      'child_org_id',
      'type',
      'data_sharing',
      'version',
    ])
    .where('parent_org_id', '=', parentOrgId)
    .where('child_org_id', '=', childOrgId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!row) throw federationNotFound('Federation relationship not found');
  return {
    id: row.id,
    parentOrgId: row.parent_org_id,
    childOrgId: row.child_org_id,
    type: row.type as FederationRelationshipType,
    dataSharing: federationSharingSchema.parse(row.data_sharing ?? {}),
    version: row.version,
  };
}

export function requireSharingKey(
  relationship: ActiveRelationship,
  key: FederationSharingKey,
): void {
  if (!relationship.dataSharing[key]) {
    throw new FederationError(
      422,
      'FEDERATION_SHARING_DENIED',
      `Data sharing for '${key}' is not granted by the member organization`,
    );
  }
}

interface DualAuditInput {
  action: string;
  entityType: string;
  entityId: string;
  /** Audit detail written in the requesting org's log. */
  requestingChanges?: AuditChanges;
  /** Audit detail written in the source org's log. */
  sourceChanges?: AuditChanges;
}

/**
 * Runs `fn` on the privileged connection inside a single transaction, then
 * appends an audit event in BOTH the requesting org and the source org. The
 * GUCs are set to the source org so any RLS-aware helper still resolves the
 * source tenant; admin privilege bypasses RLS regardless.
 */
export async function withFederationAccess<T>(
  options: {
    requesting: OrgContext;
    sourceOrgId: string;
    audit: DualAuditInput;
  },
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.org_id', ${options.sourceOrgId}, true)`.execute(
      trx,
    );
    await sql`SELECT set_config('app.actor_id', ${options.requesting.actor.accountId}, true)`.execute(
      trx,
    );
    const result = await fn(trx);
    const sourceContext: OrgContext = {
      orgId: options.sourceOrgId,
      actor: options.requesting.actor,
    };
    await appendAuditEvent(trx, sourceContext, {
      action: options.audit.action,
      entityType: options.audit.entityType,
      entityId: options.audit.entityId,
      changes: {
        requestingOrgId: {
          tier: 'internal',
          after: options.requesting.orgId,
        },
        ...(options.audit.sourceChanges ?? {}),
      },
    });
    await appendAuditEvent(trx, options.requesting, {
      action: options.audit.action,
      entityType: options.audit.entityType,
      entityId: options.audit.entityId,
      changes: {
        sourceOrgId: { tier: 'internal', after: options.sourceOrgId },
        ...(options.audit.requestingChanges ?? {}),
      },
    });
    return result;
  });
}
