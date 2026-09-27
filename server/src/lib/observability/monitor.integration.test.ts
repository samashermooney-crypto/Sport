import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';

import { collectOperationalMetrics } from './monitor';

describe('operational metrics collection', () => {
  it('reads global operations and tenant payment/email counts inside withOrg', async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    const organizationId = randomUUID();
    const slug = `ops-${organizationId.replaceAll('-', '').slice(0, 12)}`;
    try {
      await admin.query(
        `INSERT INTO organizations(id, slug, name, kind, timezone)
         VALUES ($1, $2, 'OPS metrics fixture', 'league', 'America/Chicago')`,
        [organizationId, slug],
      );
    } finally {
      await admin.end();
    }

    const database = createDatabase(
      process.env.TEST_DATABASE_APP_URL ??
        'postgres://athlentry_app@127.0.0.1:5432/athlentry_test',
    );
    try {
      const metrics = await collectOperationalMetrics(database);
      expect(metrics.pendingJobs).toBeGreaterThanOrEqual(0);
      expect(metrics.failedJobs).toBeGreaterThanOrEqual(0);
      expect(metrics.paymentAttempts15m).toBeGreaterThanOrEqual(0);
      expect(metrics.paymentFailures15m).toBeGreaterThanOrEqual(0);
      expect(metrics.emails30m).toBeGreaterThanOrEqual(0);
      expect(metrics.emailBounces30m).toBeGreaterThanOrEqual(0);
      expect(metrics.now).toBeInstanceOf(Date);
    } finally {
      await database.destroy();
      const cleanup = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      await cleanup.connect();
      try {
        await cleanup.query('DELETE FROM organizations WHERE id = $1', [
          organizationId,
        ]);
      } finally {
        await cleanup.end();
      }
    }
  });
});
