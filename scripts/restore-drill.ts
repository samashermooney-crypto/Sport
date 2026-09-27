import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import {
  createEncryptedBackup,
  parsePgConnection,
  restoreEncryptedBackup,
} from '../server/src/lib/observability/backup.js';

const verifiedTables = [
  'organizations',
  'people',
  'registrations',
  'attendance',
  'invoices',
  'payments',
  'audit_log',
] as const;

type RestoreReport = {
  scratchDatabase: string;
  migrationCount: number;
  latestMigration: number;
  tableCounts: Record<(typeof verifiedTables)[number], number>;
};

type RestoreSnapshot = Omit<RestoreReport, 'scratchDatabase'>;

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error('Database identifier is invalid');
  return `"${value}"`;
}

async function readSnapshot(client: pg.Client): Promise<RestoreSnapshot> {
  const migrations = await client.query<{
    count: string;
    latest: number | null;
  }>(
    'SELECT count(*)::text AS count, max(version)::integer AS latest FROM schema_migrations',
  );
  const migrationCount = Number(migrations.rows[0]?.count ?? '0');
  const latestMigration = migrations.rows[0]?.latest ?? 0;
  if (migrationCount === 0 || latestMigration === 0)
    throw new Error('Migration ledger is empty');

  const tableCounts = {} as RestoreReport['tableCounts'];
  for (const table of verifiedTables) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quoteIdentifier(table)}`,
    );
    tableCounts[table] = Number(result.rows[0]?.count ?? '0');
  }
  return { migrationCount, latestMigration, tableCounts };
}

export async function runRestoreDrill(): Promise<RestoreReport> {
  const sourceUrl = process.env.RESTORE_SOURCE_URL;
  const adminUrl = process.env.RESTORE_ADMIN_URL;
  if (!sourceUrl || !adminUrl)
    throw new Error('RESTORE_SOURCE_URL and RESTORE_ADMIN_URL are required');
  const source = parsePgConnection(sourceUrl);
  const admin = parsePgConnection(adminUrl);
  if (
    source.host !== admin.host ||
    source.port !== admin.port ||
    !['postgres', 'template1'].includes(admin.database) ||
    source.user === admin.user ||
    source.database.startsWith('athlentry_ops_restore_')
  ) {
    throw new Error(
      'Restore source and maintenance database are not safely isolated',
    );
  }

  const scratchDatabase = `athlentry_ops_restore_${String(Date.now())}_${randomUUID().slice(0, 8)}`;
  const scratchIdentifier = quoteIdentifier(scratchDatabase);
  const ownerIdentifier = quoteIdentifier(admin.user);
  const scratchUrl = new URL(adminUrl);
  scratchUrl.pathname = `/${scratchDatabase}`;
  const tempDirectory = await mkdtemp(
    join(tmpdir(), 'athlentry-restore-drill-'),
  );
  const adminClient = new pg.Client({ connectionString: adminUrl });
  let databaseCreated = false;
  try {
    await adminClient.connect();
    const existing = await adminClient.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [scratchDatabase],
    );
    if (existing.rows[0]?.exists)
      throw new Error('Scratch database name unexpectedly already exists');

    const sourceClient = new pg.Client({ connectionString: sourceUrl });
    let sourceSnapshot: RestoreSnapshot;
    try {
      await sourceClient.connect();
      sourceSnapshot = await readSnapshot(sourceClient);
    } finally {
      await sourceClient.end().catch(() => undefined);
    }

    const encryptedPath = await createEncryptedBackup(sourceUrl, tempDirectory);

    await adminClient.query(
      `CREATE DATABASE ${scratchIdentifier} OWNER ${ownerIdentifier}`,
    );
    databaseCreated = true;
    await restoreEncryptedBackup(encryptedPath, scratchUrl.toString());

    const scratchClient = new pg.Client({
      connectionString: scratchUrl.toString(),
    });
    try {
      await scratchClient.connect();
      const restoredSnapshot = await readSnapshot(scratchClient);
      if (JSON.stringify(restoredSnapshot) !== JSON.stringify(sourceSnapshot)) {
        throw new Error('Restored schema or row counts differ from the source');
      }
      return {
        scratchDatabase,
        ...restoredSnapshot,
      };
    } finally {
      await scratchClient.end().catch(() => undefined);
    }
  } finally {
    if (databaseCreated) {
      await adminClient.query(`DROP DATABASE IF EXISTS ${scratchIdentifier}`);
    }
    await adminClient.end().catch(() => undefined);
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function formatReport(report: RestoreReport): string {
  const counts = verifiedTables
    .map((table) => `${table}=${String(report.tableCounts[table])}`)
    .join(', ');
  return [
    'restore_drill: passed',
    `scratch_database: ${report.scratchDatabase}`,
    'scratch_database_cleanup: passed',
    `schema_migrations: ${String(report.migrationCount)}`,
    `latest_migration: ${String(report.latestMigration)}`,
    `verified_row_counts: ${counts}`,
    'encryption_authentication: passed',
  ].join('\n');
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  runRestoreDrill()
    .then((report) => process.stdout.write(`${formatReport(report)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Restore drill failed'}\n`,
      );
      process.exitCode = 1;
    });
}
