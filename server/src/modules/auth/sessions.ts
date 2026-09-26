import { createHash, randomBytes } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Transaction } from 'kysely';

import type { DB } from '../../db/types';

const day = 24 * 60 * 60 * 1_000;
const privilegedIdle = 12 * 60 * 60 * 1_000;
const stepUpLifetime = 15 * 60 * 1_000;

function digest(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

export interface SessionOptions {
  accountId: string;
  kind: 'cookie' | 'bearer';
  client: 'web' | 'ios' | 'android';
  privileged: boolean;
  mfaVerifiedAt?: Date;
  ip?: string;
  userAgent?: string;
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
      'sessions.absolute_expires_at',
    ])
    .where('sessions.token_hash', '=', digest(raw))
    .where('sessions.revoked_at', 'is', null)
    .where('sessions.idle_expires_at', '>', now)
    .where('sessions.absolute_expires_at', '>', now)
    .where('accounts.status', '=', 'active')
    .executeTakeFirst();
  if (!row) return null;

  const idleWindow = row.mfa_verified_at ? privilegedIdle : 14 * day;
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
