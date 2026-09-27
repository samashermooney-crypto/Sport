import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';

import {
  hasStepUp,
  issueSession,
  listActiveSessions,
  resolveSession,
  revokeSession,
  revokeSessions,
  stepUpSession,
} from './sessions';

const accountId = newId();
const now = new Date('2026-09-26T18:00:00Z');
let database: Kysely<DB>;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: 'session-test@example.invalid',
      first_name: 'Session',
      last_name: 'Test',
      date_of_birth: '2000-01-01',
    })
    .execute();
});

afterAll(async () => {
  await database.destroy();
});

describe('session lifecycle', () => {
  it('stores a hashed token and enforces idle and absolute expiry', async () => {
    const issued = await database
      .transaction()
      .execute((trx) =>
        issueSession(
          trx,
          { accountId, kind: 'cookie', client: 'web', privileged: false },
          now,
        ),
      );
    expect(issued.idleExpiresAt.toISOString()).toBe('2026-10-10T18:00:00.000Z');
    expect(issued.absoluteExpiresAt.toISOString()).toBe(
      '2026-10-26T18:00:00.000Z',
    );
    const stored = await database
      .selectFrom('sessions')
      .select('token_hash')
      .where('id', '=', issued.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash.includes(Buffer.from(issued.token))).toBe(false);
    const active = await database
      .transaction()
      .execute((trx) =>
        resolveSession(
          trx,
          issued.token,
          new Date(now.getTime() + 13 * 24 * 60 * 60_000),
        ),
      );
    expect(active?.accountId).toBe(accountId);
    expect(
      await database
        .transaction()
        .execute((trx) =>
          resolveSession(
            trx,
            issued.token,
            new Date(now.getTime() + 31 * 24 * 60 * 60_000),
          ),
        ),
    ).toBeNull();
  });

  it('requires recent MFA for privileged sessions and expires step-up after 15 minutes', async () => {
    await expect(
      database
        .transaction()
        .execute((trx) =>
          issueSession(
            trx,
            { accountId, kind: 'cookie', client: 'web', privileged: true },
            now,
          ),
        ),
    ).rejects.toThrow('MFA is required');
    const issued = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId,
          kind: 'cookie',
          client: 'web',
          privileged: true,
          mfaVerifiedAt: now,
        },
        now,
      ),
    );
    expect(issued.idleExpiresAt.toISOString()).toBe('2026-09-27T06:00:00.000Z');
    expect(issued.absoluteExpiresAt.toISOString()).toBe(
      '2026-10-03T18:00:00.000Z',
    );
    expect(
      await database
        .transaction()
        .execute((trx) => stepUpSession(trx, issued.id, accountId, now)),
    ).toBe(true);
    const active = await database
      .transaction()
      .execute((trx) => resolveSession(trx, issued.token, now));
    expect(active).not.toBeNull();
    if (!active) throw new Error('Session is unexpectedly absent');
    expect(hasStepUp(active, new Date(now.getTime() + 14 * 60_000))).toBe(true);
    expect(hasStepUp(active, new Date(now.getTime() + 15 * 60_000))).toBe(
      false,
    );
    expect(
      await database
        .transaction()
        .execute((trx) => revokeSessions(trx, accountId, now)),
    ).toBeGreaterThan(0);
    expect(
      await database
        .transaction()
        .execute((trx) => resolveSession(trx, issued.token, now)),
    ).toBeNull();
  });

  it('lists and revokes a selected session owned by the account', async () => {
    const issued = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        now,
      ),
    );
    const listed = await listActiveSessions(database, accountId, now);
    expect(listed.map((session) => session.id)).toContain(issued.id);
    expect(
      await database
        .transaction()
        .execute((trx) => revokeSession(trx, accountId, issued.id, now)),
    ).toBe(true);
    expect(
      await database
        .transaction()
        .execute((trx) => revokeSession(trx, accountId, issued.id, now)),
    ).toBe(false);
    expect(
      await database
        .transaction()
        .execute((trx) => resolveSession(trx, issued.token, now)),
    ).toBeNull();
  });
});
