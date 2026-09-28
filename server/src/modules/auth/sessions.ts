import { createHash, randomBytes } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely, Transaction } from 'kysely';

import type { DB } from '../../db/types';

const day = 24 * 60 * 60 * 1_000;
const privilegedIdle = 12 * 60 * 60 * 1_000;
const stepUpLifetime = 15 * 60 * 1_000;

function digest(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

async function revokeLinkedDevices(
  trx: Transaction<DB>,
  sessionIds: string[],
  now: Date,
): Promise<void> {
  if (sessionIds.length === 0) return;
  await trx
    .updateTable('device_tokens')
    .set({ revoked_at: now, token_or_subscription: {} })
    .where('session_id', 'in', sessionIds)
    .where('revoked_at', 'is', null)
    .execute();
}

export interface SessionOptions {
  accountId: string;
  kind: 'cookie' | 'bearer';
  client: 'web' | 'ios' | 'android';
  privileged: boolean;
  mfaVerifiedAt?: Date;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface IssuedSession {
  id: string;
  token: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export async function issueSession(
  trx: Transaction<DB>,
  options: SessionOptions,
  now: Date,
): Promise<IssuedSession> {
  if (options.privileged && !options.mfaVerifiedAt) {
    throw new Error('MFA is required for privileged sessions');
  }
  if (
    options.mfaVerifiedAt &&
    (options.mfaVerifiedAt > now ||
      now.getTime() - options.mfaVerifiedAt.getTime() > stepUpLifetime)
  ) {
    throw new Error('MFA verification is stale');
  }
  if ((options.kind === 'cookie') !== (options.client === 'web')) {
    throw new Error(
      'Cookie sessions are web-only and bearer sessions are native-only',
    );
  }
  const token = randomBytes(32).toString('base64url');
  const id = newId();
  const absoluteExpiresAt = new Date(
    now.getTime() + (options.privileged ? 7 : 30) * day,
  );
  const idleExpiresAt = new Date(
    now.getTime() + (options.privileged ? privilegedIdle : 14 * day),
  );
  await trx
    .insertInto('sessions')
    .values({
      id,
      token_hash: digest(token),
      account_id: options.accountId,
      kind: options.kind,
      client: options.client,
      privileged: options.privileged,
      idle_expires_at: idleExpiresAt,
      absolute_expires_at: absoluteExpiresAt,
      mfa_verified_at: options.mfaVerifiedAt ?? null,
      ip: options.ip ?? null,
      user_agent: options.userAgent ?? null,
    })
    .execute();
  await trx
    .insertInto('security_events')
    .values({
      id: newId(),
      account_id: options.accountId,
      action: 'session.created',
      details: { sessionId: id, client: options.client },
      ip: options.ip ?? null,
      user_agent: options.userAgent ?? null,
    })
    .execute();
  return { id, token, idleExpiresAt, absoluteExpiresAt };
}

export interface ActiveSession {
  id: string;
  accountId: string;
  kind: 'cookie' | 'bearer';
  client: 'web' | 'ios' | 'android';
  privileged: boolean;
  elevatedUntil: Date | null;
  mfaVerifiedAt: Date | null;
}

export async function resolveSession(
  trx: Transaction<DB>,
  raw: string,
  now: Date,
): Promise<ActiveSession | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const row = await trx
    .selectFrom('sessions')
    .innerJoin('accounts', 'accounts.id', 'sessions.account_id')
    .select([
      'sessions.id',
      'sessions.account_id',
      'sessions.kind',
      'sessions.client',
      'sessions.elevated_until',
      'sessions.mfa_verified_at',
      'sessions.privileged',
      'sessions.idle_expires_at',
      'sessions.absolute_expires_at',
      'accounts.status as account_status',
    ])
    .where('sessions.token_hash', '=', digest(raw))
    .where('sessions.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;
  if (
    row.idle_expires_at <= now ||
    row.absolute_expires_at <= now ||
    row.account_status !== 'active'
  ) {
    await revokeLinkedDevices(trx, [row.id], now);
    return null;
  }

  const idleWindow = row.privileged ? privilegedIdle : 14 * day;
  const idleExpiresAt = new Date(
    Math.min(now.getTime() + idleWindow, row.absolute_expires_at.getTime()),
  );
  const refreshed = await trx
    .updateTable('sessions')
    .set({ idle_expires_at: idleExpiresAt })
    .where('id', '=', row.id)
    .where('revoked_at', 'is', null)
    .where('idle_expires_at', '>', now)
    .where('absolute_expires_at', '>', now)
    .returning('id')
    .executeTakeFirst();
  if (!refreshed) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind as ActiveSession['kind'],
    client: row.client as ActiveSession['client'],
    privileged: row.privileged,
    elevatedUntil: row.elevated_until,
    mfaVerifiedAt: row.mfa_verified_at,
  };
}

export async function stepUpSession(
  trx: Transaction<DB>,
  sessionId: string,
  accountId: string,
  now: Date,
): Promise<boolean> {
  const updated = await trx
    .updateTable('sessions')
    .set({ elevated_until: new Date(now.getTime() + stepUpLifetime) })
    .where('id', '=', sessionId)
    .where('account_id', '=', accountId)
    .where('revoked_at', 'is', null)
    .where('idle_expires_at', '>', now)
    .where('absolute_expires_at', '>', now)
    .returning('id')
    .executeTakeFirst();
  if (!updated) return false;
  await trx
    .insertInto('security_events')
    .values({
      id: newId(),
      account_id: accountId,
      action: 'session.step_up',
      details: { sessionId },
    })
    .execute();
  return true;
}

export function hasStepUp(session: ActiveSession, now: Date): boolean {
  return session.elevatedUntil !== null && session.elevatedUntil > now;
}

export async function revokeSessions(
  trx: Transaction<DB>,
  accountId: string,
  now: Date,
  keepSessionId?: string,
): Promise<number> {
  let query = trx
    .updateTable('sessions')
    .set({ revoked_at: now })
    .where('account_id', '=', accountId)
    .where('revoked_at', 'is', null);
  if (keepSessionId) query = query.where('id', '!=', keepSessionId);
  const rows = await query.returning('id').execute();
  await revokeLinkedDevices(
    trx,
    rows.map((row) => row.id),
    now,
  );
  for (const row of rows) {
    await trx
      .insertInto('security_events')
      .values({
        id: newId(),
        account_id: accountId,
        action: 'session.revoked',
        details: { sessionId: row.id },
      })
      .execute();
  }
  return rows.length;
}

export interface ListedSession {
  id: string;
  kind: 'cookie' | 'bearer';
  client: 'web' | 'ios' | 'android';
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export async function listActiveSessions(
  database: Kysely<DB>,
  accountId: string,
  now: Date,
): Promise<ListedSession[]> {
  const rows = await database
    .selectFrom('sessions')
    .select([
      'id',
      'kind',
      'client',
      'created_at',
      'updated_at',
      'idle_expires_at',
      'absolute_expires_at',
      'ip',
      'user_agent',
    ])
    .where('account_id', '=', accountId)
    .where('revoked_at', 'is', null)
    .where('idle_expires_at', '>', now)
    .where('absolute_expires_at', '>', now)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as ListedSession['kind'],
    client: row.client as ListedSession['client'],
    createdAt: row.created_at,
    lastSeenAt: row.updated_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    ip: row.ip,
    userAgent: row.user_agent,
  }));
}

export async function revokeSession(
  trx: Transaction<DB>,
  accountId: string,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  const revoked = await trx
    .updateTable('sessions')
    .set({ revoked_at: now })
    .where('id', '=', sessionId)
    .where('account_id', '=', accountId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!revoked) return false;
  await revokeLinkedDevices(trx, [revoked.id], now);
  await trx
    .insertInto('security_events')
    .values({
      id: newId(),
      account_id: accountId,
      action: 'session.revoked',
      details: { sessionId },
    })
    .execute();
  return true;
}

export async function rotateSessionForStepUp(
  trx: Transaction<DB>,
  session: ActiveSession,
  now: Date,
  metadata: Pick<SessionOptions, 'ip' | 'userAgent'> = {},
  verifiedMfaAt?: Date,
): Promise<IssuedSession | null> {
  const current = await trx
    .selectFrom('sessions')
    .select([
      'kind',
      'client',
      'privileged',
      'mfa_verified_at',
      'idle_expires_at',
      'absolute_expires_at',
    ])
    .where('id', '=', session.id)
    .where('account_id', '=', session.accountId)
    .where('revoked_at', 'is', null)
    .where('idle_expires_at', '>', now)
    .where('absolute_expires_at', '>', now)
    .forUpdate()
    .executeTakeFirst();
  if (!current) return null;

  const inheritedMfaAt = current.mfa_verified_at;
  const recentInheritedMfaAt =
    inheritedMfaAt &&
    inheritedMfaAt <= now &&
    now.getTime() - inheritedMfaAt.getTime() <= stepUpLifetime
      ? inheritedMfaAt
      : undefined;
  const mfaVerifiedAt = verifiedMfaAt ?? recentInheritedMfaAt;
  if (current.privileged && !mfaVerifiedAt) return null;

  if (!(await revokeSession(trx, session.accountId, session.id, now)))
    return null;

  const issued = await issueSession(
    trx,
    {
      accountId: session.accountId,
      kind: current.kind as SessionOptions['kind'],
      client: current.client as SessionOptions['client'],
      privileged: current.privileged,
      ...(mfaVerifiedAt ? { mfaVerifiedAt } : {}),
      ...metadata,
    },
    now,
  );
  const idleExpiresAt = new Date(
    Math.min(
      issued.idleExpiresAt.getTime(),
      current.absolute_expires_at.getTime(),
    ),
  );
  const boundedExpiry = await trx
    .updateTable('sessions')
    .set({
      idle_expires_at: idleExpiresAt,
      absolute_expires_at: current.absolute_expires_at,
    })
    .where('id', '=', issued.id)
    .where('account_id', '=', session.accountId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!boundedExpiry) throw new Error('Could not retain session expiry');
  if (!(await stepUpSession(trx, issued.id, session.accountId, now)))
    throw new Error('Could not elevate the rotated session');
  return {
    ...issued,
    idleExpiresAt,
    absoluteExpiresAt: current.absolute_expires_at,
  };
}
