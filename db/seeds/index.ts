import { createHash } from 'node:crypto';

import pg from 'pg';

import { createDatabase } from '../../server/src/db/kysely';
import { migrate } from '../../server/src/db/migrate';
import { seedFederationDemo } from '../../server/src/modules/federation/demo';
import { closeFederationAdminDatabase } from '../../server/src/modules/federation/privileged';
import { builtInSportTemplates } from '../../shared/src/sport/templates';

import { seedDemo, seedLoad } from './demo';

const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : 'demo';
if (profile !== 'e2e' && profile !== 'demo' && profile !== 'load') {
  process.stderr.write(
    'Use --profile demo, --profile e2e, or --profile load.\n',
  );
  process.exitCode = 1;
} else {
  const url =
    process.env.DATABASE_ADMIN_URL ??
    `postgres://athlentry_admin@127.0.0.1:5432/athlentry_${profile === 'e2e' ? 'e2e' : 'dev'}`;
  process.env.DATABASE_ADMIN_URL ??= url;
  (async () => {
    process.env.DATABASE_ADMIN_URL ??= url;
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
    if (profile === 'demo') {
      const database = createDatabase(url);
      try {
        const seeded = await seedFederationDemo(database);
        process.stdout.write(
          seeded
            ? `Seeded federation demo ${seeded.associationOrgId}.\n`
            : 'Federation demo already exists.\n',
        );
      } finally {
        await database.destroy();
        await closeFederationAdminDatabase();
      }
    }
  })().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
