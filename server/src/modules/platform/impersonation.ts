import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';

import { PlatformAccessError } from './service';
import type { PlatformStaff } from './service';

export type Impersonation = {
  id: string;
  organizationId: string;
  reason: string;
  readOnly: true;
  expiresAt: string;
};

export async function startImpersonation(
  database: Kysely<DB>,
  actor: PlatformStaff,
  organizationId: string,
  reason: string,
  now: Date,
): Promise<Impersonation> {
  const cleanReason = reason.trim();
  if (cleanReason.length < 10 || cleanReason.length > 500)
    throw new RangeError(
      'Impersonation requires a reason of 10–500 characters',
    );
  if (actor.role === 'finance_ops')
    throw new PlatformAccessError('Finance operations cannot impersonate');
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1_000);
  return database.transaction().execute(async (trx) => {
    const org = await trx
      .selectFrom('organizations')
      .select('id')
      .where('id', '=', organizationId)
      .executeTakeFirst();
    if (!org) throw new PlatformAccessError('Organization not found', 404);
    await sql`INSERT INTO platform_impersonations
      (id, staff_account_id, target_organization_id, reason, started_at, expires_at)
      VALUES (${id}, ${actor.accountId}, ${organizationId}, ${cleanReason},
        ${now}, ${expiresAt})`.execute(trx);
    await sql`INSERT INTO platform_audit_log
      (id, staff_account_id, action, target_organization_id, impersonation_id, details)
      VALUES (${randomUUID()}, ${actor.accountId}, 'impersonation.start',
        ${organizationId}, ${id}, ${JSON.stringify({ reason: cleanReason, readOnly: true })}::jsonb)`.execute(
      trx,
    );
    return {
      id,
      organizationId,
      reason: cleanReason,
      readOnly: true,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export async function getImpersonation(
  database: Kysely<DB>,
  actor: PlatformStaff,
  id: string,
  now: Date,
): Promise<Impersonation> {
  const row = await sql<{
    target_organization_id: string;
    reason: string;
    expires_at: Date;
  }>`SELECT target_organization_id, reason, expires_at
      FROM platform_impersonations WHERE id = ${id}
        AND staff_account_id = ${actor.accountId}
        AND ended_at IS NULL AND expires_at > ${now}`.execute(database);
  const current = row.rows[0];
  if (!current) throw new PlatformAccessError('Impersonation not found', 404);
  return {
    id,
    organizationId: current.target_organization_id,
    reason: current.reason,
    readOnly: true,
    expiresAt: current.expires_at.toISOString(),
  };
}

export async function endImpersonation(
  database: Kysely<DB>,
  actor: PlatformStaff,
  id: string,
  now: Date,
): Promise<void> {
  await database.transaction().execute(async (trx) => {
    const rows = await sql<{ target_organization_id: string }>`
      UPDATE platform_impersonations SET ended_at = ${now}
      WHERE id = ${id} AND staff_account_id = ${actor.accountId}
        AND ended_at IS NULL
      RETURNING target_organization_id
    `.execute(trx);
    const current = rows.rows[0];
    if (!current) throw new PlatformAccessError('Impersonation not found', 404);
    await sql`INSERT INTO platform_audit_log
      (id, staff_account_id, action, target_organization_id, impersonation_id)
      VALUES (${randomUUID()}, ${actor.accountId}, 'impersonation.end',
        ${current.target_organization_id}, ${id})`.execute(trx);
  });
}

export async function auditImpersonatedRequest(
  database: Kysely<DB>,
  actor: PlatformStaff,
  id: string,
  request: { method: string; path: string; organizationId: string },
  now: Date,
): Promise<void> {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
    throw new PlatformAccessError('Impersonation is read-only');
  const current = await getImpersonation(database, actor, id, now);
  if (current.organizationId !== request.organizationId)
    throw new PlatformAccessError('Impersonation scope mismatch', 404);
  await sql`INSERT INTO platform_audit_log
    (id, staff_account_id, action, target_organization_id, impersonation_id, details)
    VALUES (${randomUUID()}, ${actor.accountId}, 'impersonation.request',
      ${request.organizationId}, ${id},
      ${JSON.stringify({ method: request.method, path: request.path })}::jsonb)`.execute(
    database,
  );
}
