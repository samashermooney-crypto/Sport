import { readdir } from 'node:fs/promises';

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
      const database = await client.query<{ name: string }>(
        'SELECT current_database() AS name',
      );
      expect(database.rows[0]?.name).toMatch(/^t_[0-9a-f]{32}$/);
      const migrations = (
        await readdir(new URL('../../db/migrations/', import.meta.url))
      ).filter((name) => /^\d{4}_.+\.sql$/.test(name));
      const applied = await client.query<{ name: string }>(
        'SELECT name FROM schema_migrations',
      );
      expect(applied.rows.map((row) => row.name)).toEqual(
        expect.arrayContaining(migrations),
      );
    } finally {
      await client.end();
    }
  });
});
