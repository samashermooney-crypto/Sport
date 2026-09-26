import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const migrationsDir = fileURLToPath(
  new URL('../../../db/migrations/', import.meta.url),
);
const lockId = 472091118;

export async function migrate(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const names = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const name of names) {
      const version = Number(name.slice(0, 4));
      const sql = await readFile(
        new URL(`../../../db/migrations/${name}`, import.meta.url),
        'utf8',
      );
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [version],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Migration ${name} changed after application`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [version, name, checksum],
        );
        await client.query('COMMIT');
        process.stdout.write(`Applied ${name}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [lockId])
      .catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url =
    process.env.DATABASE_ADMIN_URL ??
    'postgres://athlentry_admin@127.0.0.1:5432/athlentry_dev';
  migrate(url).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
