import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { deviceRegistrationBodySchema } from '@shared/schemas/auth';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import type { Json } from '../../db/types';

import { AuthDomainError } from './domain-error';
import type { ActiveSession } from './sessions';

export type DeviceRegistration = ReturnType<
  typeof deviceRegistrationBodySchema.parse
>;

function canonicalDevice(input: DeviceRegistration): {
  hash: Buffer;
  stored: Json;
} {
  const identifier =
    input.platform === 'webpush' ? input.subscription.endpoint : input.token;
  const hash = createHash('sha256')
    .update(`${input.platform}:${identifier}`)
    .digest();
  const stored: Json =
    input.platform === 'webpush' ? input.subscription : { token: input.token };
  return { hash, stored };
}

function assertPlatform(
  session: ActiveSession,
  platform: DeviceRegistration['platform'],
): void {
  const matches =
    (session.client === 'web' && platform === 'webpush') ||
    (session.client === 'ios' && platform === 'apns') ||
    (session.client === 'android' && platform === 'fcm');
  if (!matches)
    throw new AuthDomainError(
      403,
      'FORBIDDEN',
      'Device platform does not match this session',
    );
}

export interface RegisteredDevice {
  id: string;
  platform: 'webpush' | 'apns' | 'fcm';
  lastSeenAt: Date;
}

export async function registerDevice(
  database: Kysely<DB>,
  session: ActiveSession,
  input: DeviceRegistration,
  now: Date,
): Promise<RegisteredDevice> {
  const parsed = deviceRegistrationBodySchema.parse(input);
  assertPlatform(session, parsed.platform);
  const { hash, stored } = canonicalDevice(parsed);
  return database.transaction().execute(async (trx) => {
    const activeSession = await trx
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', session.id)
      .where('account_id', '=', session.accountId)
      .where('revoked_at', 'is', null)
      .where('idle_expires_at', '>', now)
      .where('absolute_expires_at', '>', now)
      .forUpdate()
      .executeTakeFirst();
    if (!activeSession) {
      throw new AuthDomainError(401, 'UNAUTHENTICATED', 'Session expired');
    }
    const inserted = await trx
      .insertInto('device_tokens')
      .values({
        id: newId(),
        account_id: session.accountId,
        session_id: session.id,
        platform: parsed.platform,
        token_hash: hash,
        token_or_subscription: stored,
        last_seen_at: now,
      })
      .onConflict((conflict) =>
        conflict.columns(['platform', 'token_hash']).doNothing(),
      )
      .returning(['id', 'platform', 'last_seen_at'])
      .executeTakeFirst();
    if (inserted)
      return {
        id: inserted.id,
        platform: inserted.platform as RegisteredDevice['platform'],
        lastSeenAt: inserted.last_seen_at,
      };
    const existing = await trx
      .selectFrom('device_tokens')
      .select(['id', 'account_id'])
      .where('platform', '=', parsed.platform)
      .where('token_hash', '=', hash)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (existing.account_id !== session.accountId) {
      throw new AuthDomainError(
        409,
        'CONFLICT',
        'Device is registered to another account',
      );
    }
    const updated = await trx
      .updateTable('device_tokens')
      .set({
        token_or_subscription: stored,
        last_seen_at: now,
        session_id: session.id,
        revoked_at: null,
      })
      .where('id', '=', existing.id)
      .returning(['id', 'platform', 'last_seen_at'])
      .executeTakeFirstOrThrow();
    return {
      id: updated.id,
      platform: updated.platform as RegisteredDevice['platform'],
      lastSeenAt: updated.last_seen_at,
    };
  });
}

export async function listDevices(
  database: Kysely<DB>,
  accountId: string,
  now = new Date(),
): Promise<RegisteredDevice[]> {
  const rows = await database
    .selectFrom('device_tokens')
    .innerJoin('sessions', 'sessions.id', 'device_tokens.session_id')
    .select([
      'device_tokens.id',
      'device_tokens.platform',
      'device_tokens.last_seen_at',
    ])
    .where('device_tokens.account_id', '=', accountId)
    .where('device_tokens.revoked_at', 'is', null)
    .where('sessions.revoked_at', 'is', null)
    .where('sessions.idle_expires_at', '>', now)
    .where('sessions.absolute_expires_at', '>', now)
    .orderBy('device_tokens.last_seen_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform as RegisteredDevice['platform'],
    lastSeenAt: row.last_seen_at,
  }));
}

export async function expireStaleDevices(
  database: Kysely<DB>,
  now: Date,
): Promise<number> {
  const expired = await database
    .updateTable('device_tokens')
    .set({ revoked_at: now, token_or_subscription: {} })
    .where('revoked_at', 'is', null)
    .where('session_id', 'in', (query) =>
      query
        .selectFrom('sessions')
        .select('id')
        .where((expression) =>
          expression.or([
            expression('revoked_at', 'is not', null),
            expression('idle_expires_at', '<=', now),
            expression('absolute_expires_at', '<=', now),
          ]),
        ),
    )
    .returning('id')
    .execute();
  return expired.length;
}

export async function revokeDevice(
  database: Kysely<DB>,
  accountId: string,
  id: string,
  now: Date,
): Promise<boolean> {
  const row = await database
    .updateTable('device_tokens')
    .set({ revoked_at: now, token_or_subscription: {} })
    .where('id', '=', id)
    .where('account_id', '=', accountId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return Boolean(row);
}
