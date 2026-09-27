import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { createApp } from './app';

describe('Phase 0 server', () => {
  it('responds to health checks', async () => {
    const server = createApp().listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Server did not bind a TCP port');
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/healthz`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      server.close();
    }
  });

  it('uses its own migrated PostgreSQL database', async () => {
    const client = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await client.connect();
    try {
      const result = await client.query<{
        name: string;
        migration_count: string;
      }>(
        `SELECT current_database() AS name, count(*)::text AS migration_count FROM schema_migrations`,
      );
      expect(result.rows[0]?.name).toMatch(/^t_[0-9a-f]{32}$/);
      expect(result.rows[0]?.migration_count).toBe('9');
    } finally {
      await client.end();
    }
  });
});
