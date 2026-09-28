import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import express from 'express';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';

import { createSportsRouter } from './routes';
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

it('serves the authenticated sport-profile lifecycle over HTTP', async () => {
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

  const origin = 'http://127.0.0.1:5173';
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await database
    .insertInto('sessions')
    .values({
      id: newId(),
      account_id: actor.actor.accountId,
      token_hash: createHash('sha256').update(token).digest(),
      kind: 'bearer',
      client: 'web',
      privileged: false,
      idle_expires_at: new Date(now.getTime() + 60 * 60 * 1000),
      absolute_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    })
    .execute();
  const app = express();
  app.use(
    '/api/v1/sports',
    createSportsRouter({
      database,
      appUrl: origin,
      clock: () => new Date(),
    } as AuthDependencies),
  );
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/sports`;
  const authHeaders = { Authorization: `Bearer ${token}` };
  const writeHeaders = {
    ...authHeaders,
    Origin: origin,
    'X-Athlentry-Request': '1',
    'Content-Type': 'application/json',
  };

  try {
    expect((await fetch(`${baseUrl}/templates`)).status).toBe(401);
    const templates = await fetch(`${baseUrl}/templates`, {
      headers: authHeaders,
    });
    expect(templates.status).toBe(200);
    expect(templates.headers.get('Cache-Control')).toBe('no-store');
    expect(await templates.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'soccer' })]),
    );

    expect(
      (await fetch(`${baseUrl}/orgs/not-a-uuid`, { headers: authHeaders }))
        .status,
    ).toBe(400);
    expect((await fetch(`${baseUrl}/orgs/${actor.orgId}`)).status).toBe(401);
    const deniedWrite = await fetch(`${baseUrl}/orgs/${actor.orgId}`, {
      method: 'POST',
      headers: { ...writeHeaders, Origin: 'https://other.example' },
      body: JSON.stringify({ templateKey: 'soccer' }),
    });
    expect(deniedWrite.status).toBe(403);

    const missingTemplate = await fetch(`${baseUrl}/orgs/${actor.orgId}`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ templateKey: 'not-a-template' }),
    });
    expect(missingTemplate.status).toBe(404);
    const cloned = await fetch(`${baseUrl}/orgs/${actor.orgId}`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ templateKey: 'soccer' }),
    });
    expect(cloned.status).toBe(201);
    const profile = (await cloned.json()) as {
      id: string;
      version: number;
      profile: typeof template;
    };
    expect(profile.version).toBe(1);
    expect(
      (
        await fetch(`${baseUrl}/orgs/${actor.orgId}`, {
          method: 'POST',
          headers: writeHeaders,
          body: JSON.stringify({ templateKey: 'soccer' }),
        })
      ).status,
    ).toBe(409);

    const listed = await fetch(`${baseUrl}/orgs/${actor.orgId}`, {
      headers: authHeaders,
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([
      expect.objectContaining({
        id: profile.id,
        version: 1,
        hasResults: false,
      }),
    ]);

    const revisedProfile = {
      ...template,
      name: { ...template.name, en: 'Soccer Revised' },
    };
    const updated = await fetch(
      `${baseUrl}/orgs/${actor.orgId}/${profile.id}`,
      {
        method: 'PATCH',
        headers: writeHeaders,
        body: JSON.stringify({ expectedVersion: 1, profile: revisedProfile }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual(
      expect.objectContaining({ id: profile.id, version: 2 }),
    );

    const conflict = await fetch(
      `${baseUrl}/orgs/${actor.orgId}/${profile.id}`,
      {
        method: 'PATCH',
        headers: writeHeaders,
        body: JSON.stringify({ expectedVersion: 1, profile: revisedProfile }),
      },
    );
    expect(conflict.status).toBe(409);
    expect(
      (
        await fetch(`${baseUrl}/orgs/${actor.orgId}/not-a-uuid/versions`, {
          headers: authHeaders,
        })
      ).status,
    ).toBe(400);

    const versions = await fetch(
      `${baseUrl}/orgs/${actor.orgId}/${profile.id}/versions`,
      { headers: authHeaders },
    );
    expect(versions.status).toBe(200);
    expect(
      ((await versions.json()) as Array<{ version: number }>).map(
        ({ version }) => version,
      ),
    ).toEqual([2, 1]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
