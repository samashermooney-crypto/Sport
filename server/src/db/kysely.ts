import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { DB } from './types';

pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(
      'PostgreSQL bigint exceeds the JavaScript safe integer range',
    );
  }
  return parsed;
});

/** Connections per process; size against Postgres max_connections × instances. */
export function databasePoolMax(value = process.env.DATABASE_POOL_MAX): number {
  if (value === undefined || value === '') return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200)
    throw new RangeError('DATABASE_POOL_MAX must be an integer from 1 to 200');
  return parsed;
}

export function createDatabase(connectionString: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: databasePoolMax() }),
    }),
  });
}

let appDatabase: Kysely<DB> | undefined;

export function getDatabase(): Kysely<DB> {
  appDatabase ??= createDatabase(
    process.env.DATABASE_URL ??
      'postgres://athlentry_app@127.0.0.1:5432/athlentry_dev',
  );
  return appDatabase;
}
