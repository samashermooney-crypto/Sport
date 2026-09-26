import pg from 'pg';

import { migrate } from '../src/db/migrate';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://athlentry_admin@127.0.0.1:5432/athlentry_test';
const templateUrl = new URL(adminUrl);
templateUrl.pathname = '/athlentry_template';

export async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const found = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      ['athlentry_template'],
    );
    if (found.rowCount === 0)
      await admin.query(
        'CREATE DATABASE athlentry_template TEMPLATE athlentry_test OWNER athlentry_admin',
      );
  } finally {
    await admin.end();
  }
  await migrate(templateUrl.toString());
}
