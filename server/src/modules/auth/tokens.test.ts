import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';

import { consumeAuthToken, issueAuthToken } from './tokens';

let database: Kysely<DB>;
const now = new Date('2026-09-26T18:00:00Z');

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

describe('one-use auth tokens', () => {
  it('stores only a digest, rotates old tokens and rejects reuse', async () => {
    const input = {
      purpose: 'magic_link' as const,
      email: 'USER@example.invalid',
    };
    const first = await database
      .transaction()
      .execute((trx) => issueAuthToken(trx, input, now));
    const second = await database
      .transaction()
      .execute((trx) => issueAuthToken(trx, input, now));
    expect(first).not.toBe(second);
    const stored = await database
      .selectFrom('auth_tokens')
      .select(['email', 'token_hash'])
      .execute();
    expect(stored).toHaveLength(2);
    expect(stored[0]?.email).toBe('user@example.invalid');
    expect(
      stored.some((row) => row.token_hash.includes(Buffer.from(first))),
    ).toBe(false);
    expect(
      await database
        .transaction()
        .execute((trx) => consumeAuthToken(trx, 'magic_link', first, now)),
    ).toBeNull();
    expect(
      await database
        .transaction()
        .execute((trx) => consumeAuthToken(trx, 'reset_password', second, now)),
    ).toBeNull();
    const redeemed = await database
      .transaction()
      .execute((trx) => consumeAuthToken(trx, 'magic_link', second, now));
    expect(redeemed?.email).toBe('user@example.invalid');
    expect(
      await database
        .transaction()
        .execute((trx) => consumeAuthToken(trx, 'magic_link', second, now)),
    ).toBeNull();
  });

  it('rejects expired tokens and concurrent double redemption', async () => {
    const expired = await database
      .transaction()
      .execute((trx) =>
        issueAuthToken(
          trx,
          { purpose: 'magic_link', email: 'expired@example.invalid' },
          now,
        ),
      );
    expect(
      await database
        .transaction()
        .execute((trx) =>
          consumeAuthToken(
            trx,
            'magic_link',
            expired,
            new Date(now.getTime() + 15 * 60_000),
          ),
        ),
    ).toBeNull();

    const fresh = await database
      .transaction()
      .execute((trx) =>
        issueAuthToken(
          trx,
          { purpose: 'verify_email', email: 'race@example.invalid' },
          now,
        ),
      );
    const results = await Promise.all([
      database
        .transaction()
        .execute((trx) => consumeAuthToken(trx, 'verify_email', fresh, now)),
      database
        .transaction()
        .execute((trx) => consumeAuthToken(trx, 'verify_email', fresh, now)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
