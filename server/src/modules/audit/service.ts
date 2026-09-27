import { randomUUID } from 'node:crypto';

import type { Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { decodeCursor, pageFromRows } from '../../lib/pagination';

import { redactAuditChanges, redactStoredChanges } from './redaction';
import type { AuditChanges } from './redaction';
import { auditPageSchema } from './schema';

export type AuditEvent = {
  action: string;
  entityType: string;
  entityId?: string | null;
  changes?: AuditChanges;
  impersonationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

export async function appendAuditEvent(
  trx: OrgTransaction,
  context: OrgContext,
  event: AuditEvent,
): Promise<string> {
  const id = randomUUID();
  await trx
    .insertInto('audit_log')
    .values({
      id,
      org_id: context.orgId,
      actor_account_id: context.actor.accountId,
      impersonation_id: event.impersonationId ?? null,
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId ?? null,
      changes: redactAuditChanges(event.changes ?? {}) as Json,
      ip: event.ip ?? null,
      user_agent: event.userAgent ?? null,
      request_id: event.requestId ?? null,
    })
    .execute();
  return id;
}

export function withAuditedRestrictedRead<T>(
  context: OrgContext,
  entityType: string,
  entityId: string,
  fields: readonly string[],
  read: (trx: OrgTransaction) => Promise<T>,
  runWithOrg: typeof withOrg = withOrg,
): Promise<T> {
  if (
    !fields.length ||
    fields.some((field) => !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(field))
  )
    throw new RangeError('Restricted read requires named fields');
  return runWithOrg(context, async (trx) => {
    const result = await read(trx);
    await appendAuditEvent(trx, context, {
      action: 'restricted.read',
      entityType,
      entityId,
      changes: Object.fromEntries(
        fields.map((field) => [field, { tier: 'restricted', after: '[read]' }]),
      ),
    });
    return result;
  });
}

export type AuditFilter = {
  limit: number;
  cursor?: string;
  entityType?: string;
  entityId?: string;
  restrictedOnly?: boolean;
};

export class AuditAccessError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}

export async function listAuditEntries(
  context: OrgContext,
  filter: AuditFilter,
  runWithOrg: typeof withOrg = withOrg,
): Promise<ReturnType<typeof auditPageSchema.parse>> {
  if (
    !Number.isSafeInteger(filter.limit) ||
    filter.limit < 1 ||
    filter.limit > 200
  )
    throw new RangeError('Audit page limit must be 1–200');
  return runWithOrg(context, async (trx) => {
    const membership = await trx
      .selectFrom('org_memberships')
      .select('status')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .executeTakeFirst();
    if (membership?.status !== 'active')
      throw new AuditAccessError('Audit history not found');
    const roles = await trx
      .selectFrom('role_assignments')
      .select('role')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('scope_type', '=', 'org')
      .where('revoked_at', 'is', null)
      .where('pending_mfa', '=', false)
      .execute();
    const unrestricted = roles.some(
      (assignment) =>
        assignment.role === 'owner' || assignment.role === 'admin',
    );
    const compliance = roles.some(
      (assignment) => assignment.role === 'compliance',
    );
    if (!unrestricted && !compliance)
      throw new AuditAccessError('Audit history not found');
    let query = trx
      .selectFrom('audit_log')
      .selectAll()
      .where('org_id', '=', context.orgId);
    if (filter.entityType)
      query = query.where('entity_type', '=', filter.entityType);
    if (filter.entityId) query = query.where('entity_id', '=', filter.entityId);
    if (filter.restrictedOnly || !unrestricted)
      query = query.where('action', '=', 'restricted.read');
    if (filter.cursor) {
      const cursor = decodeCursor(filter.cursor, 'created_at');
      const date = new Date(String(cursor.value));
      if (Number.isNaN(date.valueOf()))
        throw new RangeError('Invalid audit cursor date');
      query = query.where((expression) =>
        expression.or([
          expression.eb('created_at', '<', date),
          expression.and([
            expression.eb('created_at', '=', date),
            expression.eb('id', '<', cursor.id),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(filter.limit + 1)
      .execute();
    const page = pageFromRows(rows, filter.limit, (row) => ({
      sort: 'created_at',
      value: row.created_at.toISOString(),
      id: row.id,
    }));
    return auditPageSchema.parse({
      items: page.items.map((row) => ({
        id: row.id,
        orgId: row.org_id,
        actorAccountId: row.actor_account_id,
        impersonationId: row.impersonation_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        changes: redactStoredChanges(row.changes),
        createdAt: row.created_at.toISOString(),
      })),
      nextCursor: page.nextCursor,
    });
  });
}
