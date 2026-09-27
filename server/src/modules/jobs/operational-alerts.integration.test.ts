import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';

import { readOperationalMetrics } from './operational-alerts';

let database: Kysely<DB>;
let administrativeDatabase: Kysely<DB>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  administrativeDatabase = createDatabase(process.env.TEST_DATABASE_URL ?? '');
});

afterAll(async () => {
  await Promise.all([database.destroy(), administrativeDatabase.destroy()]);
});

describe('operational alert metrics', () => {
  it('reads global worker signals and tenant payment/email metrics with real Postgres RLS', async () => {
    const now = new Date('2026-09-27T18:00:00Z');
    const metrics = await readOperationalMetrics(
      database,
      now,
      administrativeDatabase,
    );
    expect(metrics.now).toEqual(now);
    expect(metrics.pendingJobs).toBeGreaterThanOrEqual(0);
    expect(metrics.failedJobs).toBeGreaterThanOrEqual(0);
    expect(metrics.paymentAttempts15m).toBeGreaterThanOrEqual(0);
    expect(metrics.paymentFailures15m).toBeGreaterThanOrEqual(0);
    expect(metrics.emails30m).toBeGreaterThanOrEqual(0);
    expect(metrics.emailBounces30m).toBeGreaterThanOrEqual(0);
  });
});
