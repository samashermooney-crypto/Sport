import { newId } from '@shared/ids';
import {
  federationSharingSchema,
  type FederationRelationship,
  type FederationRelationshipStatus,
  type FederationSharing,
} from '@shared/schemas/federation';
import type { Kysely, Transaction } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { requireVersion } from '../../lib/version-check';
import { appendAuditEvent } from '../audit/service';

import { federationConflict, federationNotFound } from './errors';
import {
  findRelationship,
  getFederationAdminDatabase,
  withFederationAccess,
  type FederationRelationshipRow,
} from './privileged';

interface RelationshipRow extends FederationRelationshipRow {
  pending_sharing_by: string | null;
  initiated_by_account_id: string;
  note: string | null;
  responded_at: Date | null;
  suspended_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
}

function relationshipRow(row: unknown): RelationshipRow {
  return row as RelationshipRow;
}

async function names(
  database: Kysely<DB>,
  orgIds: readonly string[],
): Promise<Map<string, string>> {
  if (!orgIds.length) return new Map();
  const rows = await database
    .selectFrom('organizations')
    .select(['id', 'name'])
    .where('id', 'in', [...new Set(orgIds)])
    .execute();
  return new Map(rows.map((row) => [row.id, row.name]));
}

function toRelationship(
  row: RelationshipRow,
  orgNames: Map<string, string>,
): FederationRelationship {
  return {
    id: row.id,
    parentOrgId: row.parent_org_id,
    parentOrgName: orgNames.get(row.parent_org_id) ?? 'Organization',
    childOrgId: row.child_org_id,
    childOrgName: orgNames.get(row.child_org_id) ?? 'Organization',
    type: row.type as FederationRelationship['type'],
    initiator: row.initiator as FederationRelationship['initiator'],
    status: row.status as FederationRelationship['status'],
    dataSharing: federationSharingSchema.parse(row.data_sharing ?? {}),
    pendingDataSharing: row.pending_data_sharing
      ? federationSharingSchema.parse(row.pending_data_sharing)
      : null,
    note: row.note,
    respondedAt: row.responded_at?.toISOString() ?? null,
    suspendedAt: row.suspended_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

export async function listRelationships(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<FederationRelationship[]> {
  const withOrg = createWithOrg(database);
  const rows = (await withOrg(context, (trx) =>
    trx
      .selectFrom('org_relationships')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute(),
  )).map(relationshipRow);
  const orgNames = await names(
    database,
    rows.flatMap((row) => [row.parent_org_id, row.child_org_id]),
  );
  return rows.map((row) => toRelationship(row, orgNames));
}

export async function searchOrganizations(
  database: Kysely<DB>,
  context: OrgContext,
  query: string,
): Promise<{ id: string; name: string; slug: string; kind: string }[]> {
  const term = query.trim();
  if (term.length < 2 || term.length > 100)
    throw new RangeError('Search requires 2–100 characters');
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    // Membership sanity check happens at the route layer (orgActor); orgs are
    // global rows — return only directory-level fields, never tenant data.
    const rows = await trx
      .selectFrom('organizations')
      .select(['id', 'name', 'slug', 'kind'])
      .where('status', 'in', ['onboarding', 'active'])
      .where((eb) =>
        eb.or([
          eb('slug', 'ilike', `${term}%`),
          eb('name', 'ilike', `%${term}%`),
        ]),
      )
      .where('id', '<>', context.orgId)
      .orderBy('name')
      .limit(20)
      .execute();
    return rows;
  });
}

export async function createRelationship(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    direction: 'invite' | 'request';
    organizationId: string;
    type: 'member_club' | 'affiliate';
    dataSharing: FederationSharing;
    note?: string | undefined;
  },
): Promise<FederationRelationship> {
  if (input.organizationId === context.orgId)
    throw federationConflict('An organization cannot federate with itself');
  const parentOrgId =
    input.direction === 'invite' ? context.orgId : input.organizationId;
  const childOrgId =
    input.direction === 'invite' ? input.organizationId : context.orgId;
  const initiator = input.direction === 'invite' ? 'parent' : 'child';
  const proposed = federationSharingSchema.parse(input.dataSharing);
  const target = await database
    .selectFrom('organizations')
    .select(['id', 'name', 'status'])
    .where('id', '=', input.organizationId)
    .executeTakeFirst();
  if (!target || !['onboarding', 'active'].includes(target.status))
    throw federationNotFound('Organization not found');

  const id = newId();
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    const existing = await findRelationship(trx, parentOrgId, childOrgId);
    if (existing)
      throw federationConflict('A live relationship already exists');
    await trx
      .insertInto('org_relationships')
      .values({
        id,
        parent_org_id: parentOrgId,
        child_org_id: childOrgId,
        type: input.type,
        initiator,
        status: 'invited',
        data_sharing: {},
        pending_data_sharing: proposed,
        pending_sharing_by: context.actor.accountId,
        initiated_by_account_id: context.actor.accountId,
        note: input.note ?? null,
      })
      .execute();
    for (const orgId of [context.orgId, input.organizationId]) {
      const other = orgId === context.orgId ? input.organizationId : context.orgId;
      await appendAuditEvent(trx, { orgId, actor: context.actor }, {
        action: 'federation.relationship.invited',
        entityType: 'org_relationship',
        entityId: id,
        changes: {
          direction: { tier: 'internal', after: input.direction },
          otherOrgId: { tier: 'internal', after: other },
        },
      });
    }
    const row = relationshipRow(
      await trx
        .selectFrom('org_relationships')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    const orgNames = await names(database, [parentOrgId, childOrgId]);
    return toRelationship(row, orgNames);
  });
}

async function transition(
  context: OrgContext,
  relationshipId: string,
  run: (trx: Transaction<DB>, row: RelationshipRow) => Promise<void>,
  auditAction: string,
): Promise<FederationRelationship> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    const raw = await trx
      .selectFrom('org_relationships')
      .selectAll()
      .where('id', '=', relationshipId)
      .forUpdate()
      .executeTakeFirst();
    const row = raw ? relationshipRow(raw) : undefined;
    if (
      !row ||
      (row.parent_org_id !== context.orgId && row.child_org_id !== context.orgId)
    )
      throw federationNotFound('Relationship not found');
    await run(trx, row);
    for (const orgId of [row.parent_org_id, row.child_org_id]) {
      await appendAuditEvent(trx, { orgId, actor: context.actor }, {
        action: auditAction,
        entityType: 'org_relationship',
        entityId: row.id,
        changes: { status: { tier: 'internal', after: undefined } },
      });
    }
    const fresh = relationshipRow(
      await trx
        .selectFrom('org_relationships')
        .selectAll()
        .where('id', '=', relationshipId)
        .executeTakeFirstOrThrow(),
    );
    const orgNames = await getFederationAdminDatabase()
      .selectFrom('organizations')
      .select(['id', 'name'])
      .where('id', 'in', [fresh.parent_org_id, fresh.child_org_id])
      .execute()
      .then((rows) => new Map(rows.map((r) => [r.id, r.name])));
    return toRelationship(fresh, orgNames);
  });
}

export async function acceptRelationship(
  context: OrgContext,
  relationshipId: string,
): Promise<FederationRelationship> {
  return transition(
    context,
    relationshipId,
    async (trx, row) => {
      if (row.status !== 'invited')
        throw federationConflict('Relationship is not awaiting a response');
      const responder = row.initiator === 'parent' ? 'child' : 'parent';
      const responderOrg =
        responder === 'parent' ? row.parent_org_id : row.child_org_id;
      if (responderOrg !== context.orgId)
        throw federationConflict('Only the invited side may accept');
      await trx
        .updateTable('org_relationships')
        .set({
          status: 'active',
          data_sharing: (row.pending_data_sharing ?? {}) as never,
          pending_data_sharing: null,
          pending_sharing_by: null,
          responded_at: new Date(),
          version: row.version + 1,
        })
        .where('id', '=', row.id)
        .execute();
    },
    'federation.relationship.accepted',
  );
}

export async function declineRelationship(
  context: OrgContext,
  relationshipId: string,
): Promise<FederationRelationship> {
  return transition(
    context,
    relationshipId,
    async (trx, row) => {
      if (row.status !== 'invited')
        throw federationConflict('Relationship is not awaiting a response');
      const responder = row.initiator === 'parent' ? 'child' : 'parent';
      const responderOrg =
        responder === 'parent' ? row.parent_org_id : row.child_org_id;
      if (responderOrg !== context.orgId)
        throw federationConflict('Only the invited side may decline');
      await trx
        .updateTable('org_relationships')
        .set({
          status: 'ended',
          pending_data_sharing: null,
          pending_sharing_by: null,
          responded_at: new Date(),
          ended_at: new Date(),
          ended_by_account_id: context.actor.accountId,
          end_reason: 'Declined',
          version: row.version + 1,
        })
        .where('id', '=', row.id)
        .execute();
    },
    'federation.relationship.declined',
  );
}

export async function suspendRelationship(
  context: OrgContext,
  relationshipId: string,
  reason: string | undefined,
  expectedVersion: number,
): Promise<FederationRelationship> {
  return transition(
    context,
    relationshipId,
    async (trx, row) => {
      if (row.status !== 'active')
        throw federationConflict('Only active relationships can be suspended');
      requireVersion(row, expectedVersion);
      await trx
        .updateTable('org_relationships')
        .set({
          status: 'suspended',
          suspended_at: new Date(),
          suspended_by_account_id: context.actor.accountId,
          suspend_reason: reason ?? null,
          version: row.version + 1,
        })
        .where('id', '=', row.id)
        .execute();
    },
    'federation.relationship.suspended',
  );
}

export async function resumeRelationship(
  context: OrgContext,
  relationshipId: string,
  expectedVersion: number,
): Promise<FederationRelationship> {
  return transition(
    context,
    relationshipId,
    async (trx, row) => {
      if (row.status !== 'suspended')
        throw federationConflict('Relationship is not suspended');
      requireVersion(row, expectedVersion);
      await trx
        .updateTable('org_relationships')
        .set({
          status: 'active',
          suspended_at: null,
          suspended_by_account_id: null,
          suspend_reason: null,
          version: row.version + 1,
        })
        .where('id', '=', row.id)
        .execute();
    },
    'federation.relationship.resumed',
  );
}

export async function endRelationship(
  context: OrgContext,
  relationshipId: string,
  reason: string | undefined,
  expectedVersion: number,
): Promise<FederationRelationship> {
  return transition(
    context,
    relationshipId,
    async (trx, row) => {
      if (row.status === 'ended')
        throw federationConflict('Relationship already ended');
      requireVersion(row, expectedVersion);
      await trx
        .updateTable('org_relationships')
        .set({
          status: 'ended',
          pending_data_sharing: null,
          pending_sharing_by: null,
          ended_at: new Date(),
          ended_by_account_id: context.actor.accountId,
          end_reason: reason ?? null,
          version: row.version + 1,
        })
        .where('id', '=', row.id)
        .execute();
    },
    'federation.relationship.ended',
  );
}

/**
 * Sharing changes are bilateral while a relationship is live: proposals sit in
 * pending_data_sharing until the other side accepts. One exception — the member
 * (child) org, as the data owner, may immediately revoke any key it currently
 * grants. Pure revocations by the child apply at once; anything else waits for
 * acceptance.
 */
export async function proposeSharing(
  context: OrgContext,
  relationshipId: string,
  dataSharing: FederationSharing,
  expectedVersion: number,
): Promise<FederationRelationship> {
  const proposed = federationSharingSchema.parse(dataSharing);
  return transition(
    context,
    relationshipId,
    async (trx, row) => {
      if (!['invited', 'active'].includes(row.status))
        throw federationConflict('Relationship is not live');
      requireVersion(row, expectedVersion);
      const current = federationSharingSchema.parse(row.data_sharing ?? {});
      const isChildSide = row.child_org_id === context.orgId;
      const pureRevocation = (Object.keys(proposed) as (keyof FederationSharing)[])
        .every((key) => !proposed[key] || current[key] === true);
      if (isChildSide && pureRevocation) {
        await trx
          .updateTable('org_relationships')
          .set({
            data_sharing: proposed,
            pending_data_sharing: null,
            pending_sharing_by: null,
            version: row.version + 1,
          })
          .where('id', '=', row.id)
          .execute();
        return;
      }
      await trx
        .updateTable('org_relationships')
        .set({
          pending_data_sharing: proposed,
          pending_sharing_by: context.actor.accountId,
          version: row.version + 1,
        })
        .where('id', '=', row.id)
        .execute();
    },
    'federation.sharing.proposed',
  );
}

export async function respondToSharing(
  context: OrgContext,
  relationshipId: string,
  accept: boolean,
  expectedVersion: number,
): Promise<FederationRelationship> {
  return transition(
    context,
    relationshipId,
    async (trx, row) => {
      if (!['invited', 'active'].includes(row.status))
        throw federationConflict('Relationship is not live');
      requireVersion(row, expectedVersion);
      if (!row.pending_data_sharing)
        throw federationConflict('No pending data-sharing proposal');
      if (row.pending_sharing_by === context.actor.accountId)
        throw federationConflict('The proposing side cannot accept its own proposal');
      await trx
        .updateTable('org_relationships')
        .set(
          accept
            ? {
                data_sharing: row.pending_data_sharing as never,
                pending_data_sharing: null,
                pending_sharing_by: null,
                version: row.version + 1,
              }
            : {
                pending_data_sharing: null,
                pending_sharing_by: null,
                version: row.version + 1,
              },
        )
        .where('id', '=', row.id)
        .execute();
    },
    accept
      ? 'federation.sharing.accepted'
      : 'federation.sharing.declined',
  );
}

export type { FederationRelationshipStatus };
export { withFederationAccess };
