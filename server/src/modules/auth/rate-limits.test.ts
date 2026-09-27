import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';

import { createAuthRateLimits, RateLimitExceededError } from './rate-limits';
import type { AuthRateLimits } from './rate-limits';

let database: Kysely<DB>;
let limits: AuthRateLimits;

beforeAll(() => {
  const url = process.env.TEST_DATABASE_APP_URL ?? '';
  database = createDatabase(url);
  limits = createAuthRateLimits(url);
});

afterAll(async () => {
  await limits.close();
  await database.destroy();
});

describe('Postgres-backed auth rate limits', () => {
  it('enforces eight sign-ins per IP and email without storing the identifiers', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await limits.signIn('192.0.2.5', 'person@example.invalid');
    }
    await expect(
      limits.signIn('192.0.2.5', 'PERSON@example.invalid'),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
    await limits.signIn('192.0.2.6', 'person@example.invalid');
    const stored = await database
      .selectFrom('rate_limit_points')
      .select('key')
      .execute();
    expect(stored).toHaveLength(2);
    expect(
      stored.every(
        (row) => !row.key.includes('person@') && !row.key.includes('192.0.2'),
      ),
    ).toBe(true);
  });

  it('enforces the hourly email budget across IPs for magic links', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await limits.magic(
        `192.0.2.${String(attempt + 10)}`,
        'magic@example.invalid',
      );
    }
    await expect(
      limits.magic('192.0.2.20', 'MAGIC@example.invalid'),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });
});
