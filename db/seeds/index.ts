import { createHash } from 'node:crypto';

import pg from 'pg';

import { createDatabase } from '../../server/src/db/kysely';
import { migrate } from '../../server/src/db/migrate';
import { builtInSportTemplates } from '../../shared/src/sport/templates';

import { seedDemo, seedLoad } from './demo';

const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : 'demo';
const resetE2e = process.argv.includes('--reset');

async function resetE2eSchema(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public AUTHORIZATION athlentry_admin');
    await client.query('GRANT USAGE ON SCHEMA public TO athlentry_app');
    await client.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athlentry_app',
    );
    await client.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE athlentry_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO athlentry_app',
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

if (profile !== 'e2e' && profile !== 'demo' && profile !== 'load') {
  process.stderr.write(
    'Use --profile demo, --profile e2e, or --profile load.\n',
  );
  process.exitCode = 1;
} else if (resetE2e && profile !== 'e2e') {
  process.stderr.write('--reset is supported only for the e2e seed profile.\n');
  process.exitCode = 1;
} else {
  const url =
    process.env.DATABASE_ADMIN_URL ??
    `postgres://athlentry_admin@127.0.0.1:5432/athlentry_${profile === 'e2e' ? 'e2e' : 'dev'}`;
  process.env.DATABASE_ADMIN_URL ??= url;
  (async () => {
    process.env.DATABASE_ADMIN_URL ??= url;
    if (resetE2e) await resetE2eSchema(url);
    await migrate(url);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('BEGIN');
      for (const template of builtInSportTemplates) {
        const digest = createHash('sha256').update(template.key).digest('hex');
        const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-7${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        await client.query(
          `INSERT INTO sport_templates (id, key, name, profile)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, profile = EXCLUDED.profile`,
          [id, template.key, template.name.en, JSON.stringify(template)],
        );
      }
      if (profile === 'e2e') await client.query('TRUNCATE rate_limit_points');
      await client.query('COMMIT');
      const database = createDatabase(url);
      try {
        await seedDemo(database);
        if (profile === 'load') await seedLoad(database);
      } finally {
        await database.destroy();
      }
      process.stdout.write(
        `Seeded ${String(builtInSportTemplates.length)} sport templates and ${profile} data.\n`,
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
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
