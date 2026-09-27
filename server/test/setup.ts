import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://athlentry_admin@127.0.0.1:5432/athlentry_test';
const dbName = `t_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${dbName}`;
const appUrl = new URL(
  process.env.DATABASE_APP_URL ??
    'postgres://athlentry_app@127.0.0.1:5432/athlentry_test',
);
appUrl.pathname = `/${dbName}`;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE ${dbName} TEMPLATE athlentry_template OWNER athlentry_admin`,
    );
  } finally {
    await admin.end();
  }
  process.env.TEST_DATABASE_URL = databaseUrl.toString();
  process.env.TEST_DATABASE_APP_URL = appUrl.toString();
});

afterAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes('being accessed by other users') ||
          attempt === 9
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } finally {
    await admin.end();
  }
});
