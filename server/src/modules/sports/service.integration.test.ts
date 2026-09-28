import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';

import { SportsService } from './service';

async function createOwner(database: Kysely<DB>) {
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `sports-${randomUUID()}@example.invalid`,
      first_name: 'Sport',
      last_name: 'Owner',
      date_of_birth: '1990-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `sports-${randomUUID().slice(0, 12)}`,
      name: 'Sport Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  const context = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        status: 'active',
        joined_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('role_assignments')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        role: 'owner',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
  });
  return context;
}

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('records one actor-attributed snapshot per sport profile version', async () => {
  const actor = await createOwner(database);

  const template = builtInSportTemplates.find(
    (candidate) => candidate.key === 'soccer',
  );
  if (!template) throw new Error('Built-in soccer template is missing');
  const adminUrl = new URL(
    process.env.DATABASE_ADMIN_URL ??
      'postgres://athlentry_admin@127.0.0.1:5432/athlentry_test',
  );
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required');
  adminUrl.pathname = new URL(testDatabaseUrl).pathname;
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO sport_templates (id, key, name, profile)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [newId(), template.key, template.name.en, JSON.stringify(template)],
    );
  } finally {
    await admin.end();
  }

  const service = new SportsService(database, actor);
  const created = await service.clone(template.key);
  expect(created.version).toBe(1);

  const revisedProfile = {
    ...template,
    name: { ...template.name, en: `${template.name.en} Revised` },
  };
  const updated = await service.update(
    created.id,
    created.version,
    revisedProfile,
  );
  expect(updated.version).toBe(2);

  const history = await service.history(created.id);
  expect(history.map((snapshot) => snapshot.version)).toEqual([2, 1]);

  const snapshots = await createWithOrg(database)(actor, (trx) =>
    trx
      .selectFrom('sport_profile_versions')
      .select(['version', 'created_by'])
      .where('org_id', '=', actor.orgId)
      .where('sport_profile_id', '=', created.id)
      .orderBy('version')
      .execute(),
  );
  expect(snapshots).toEqual([
    { version: 1, created_by: actor.actor.accountId },
    { version: 2, created_by: actor.actor.accountId },
  ]);
});
