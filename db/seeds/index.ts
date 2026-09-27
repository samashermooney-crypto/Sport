import pg from 'pg';

import { migrate } from '../../server/src/db/migrate';

const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : 'demo';
if (profile !== 'e2e') {
  process.stderr.write(
    'Only the empty Phase 0 e2e profile exists; organization seeds arrive in later phases.\n',
  );
  process.exitCode = 1;
} else {
  const url =
    process.env.DATABASE_ADMIN_URL ??
    'postgres://athlentry_admin@127.0.0.1:5432/athlentry_e2e';
  (async () => {
    await migrate(url);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('TRUNCATE rate_limit_points');
    } finally {
      await client.end();
    }
  })().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
