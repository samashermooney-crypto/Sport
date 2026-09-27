import { createHash } from 'node:crypto';

import pg from 'pg';

import { migrate } from '../../server/src/db/migrate';
import { builtInSportTemplates } from '../../shared/src/sport/templates';

const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : 'demo';
if (profile !== 'e2e' && profile !== 'demo') {
  process.stderr.write('Use --profile e2e or --profile demo.\n');
  process.exitCode = 1;
} else {
  const url =
    process.env.DATABASE_ADMIN_URL ??
    `postgres://athlentry_admin@127.0.0.1:5432/athlentry_${profile === 'e2e' ? 'e2e' : 'dev'}`;
  (async () => {
    await migrate(url);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('BEGIN');
      for (const profile of builtInSportTemplates) {
        const digest = createHash('sha256').update(profile.key).digest('hex');
        const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-7${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        await client.query(
          `INSERT INTO sport_templates (id, key, name, profile)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, profile = EXCLUDED.profile`,
          [id, profile.key, profile.name.en, JSON.stringify(profile)],
        );
      }
      if (profile === 'e2e') await client.query('TRUNCATE rate_limit_points');
      await client.query('COMMIT');
      process.stdout.write(
        `Seeded ${String(builtInSportTemplates.length)} sport templates for ${profile}.\n`,
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
