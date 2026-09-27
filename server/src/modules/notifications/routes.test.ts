import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';

import { createNotification } from './service';

const origin = 'http://127.0.0.1:5173';
const now = new Date('2026-09-26T18:00:00Z');
const accountId = randomUUID();
const otherAccountId = randomUUID();
const ownOrgId = randomUUID();
const otherOrgId = randomUUID();
let ownNotificationId: string;
let otherNotificationId: string;
let token: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const id of [accountId, otherAccountId]) {
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [id, `${id}@example.invalid`, 'Notification', 'Tester', '1990-01-01'],
      );
    }
    for (const id of [ownOrgId, otherOrgId]) {
      await admin.query(
        'INSERT INTO organizations(id,slug,name,kind,timezone) VALUES ($1,$2,$3,$4,$5)',
        [
          id,
          `notification-route-${id.slice(0, 8)}`,
          'Notifications',
          'club',
          'UTC',
        ],
      );
    }
    await admin.query(
      'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
      [randomUUID(), ownOrgId, accountId, 'active'],
    );
    await admin.query(
      'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
      [randomUUID(), otherOrgId, otherAccountId, 'active'],
    );
    token = randomBytes(32).toString('base64url');
    await admin.query(
      `INSERT INTO sessions(id,token_hash,account_id,kind,client,privileged,idle_expires_at,absolute_expires_at)
       VALUES ($1,$2,$3,'cookie','web',false,$4,$5)`,
      [
        randomUUID(),
        createHash('sha256').update(token).digest(),
        accountId,
        new Date(now.getTime() + 60 * 60 * 1000),
        new Date(now.getTime() + 24 * 60 * 60 * 1000),
      ],
    );
  } finally {
    await admin.end();
  }
  const database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  try {
    ownNotificationId = await createWithOrg(database)(
      { orgId: ownOrgId, actor: { accountId } },
      (trx) =>
        createNotification(
          trx,
          { orgId: ownOrgId, actor: { accountId } },
          {
            accountId,
            type: 'registration.confirmed',
            payload: {},
          },
        ),
    );
    otherNotificationId = await createWithOrg(database)(
      { orgId: otherOrgId, actor: { accountId: otherAccountId } },
      (trx) =>
        createNotification(
          trx,
          { orgId: otherOrgId, actor: { accountId: otherAccountId } },
          {
            accountId: otherAccountId,
            type: 'registration.confirmed',
            payload: {},
          },
        ),
    );
  } finally {
    await database.destroy();
  }
  const app = createApp({
    database: getDatabase(),
    appUrl: origin,
    clock: () => now,
  } as AuthDependencies);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1`;
});

afterAll(async () => {
  server.close();
  await getDatabase().destroy();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

function request(
  path: string,
  method = 'GET',
  originHeader = origin,
): Promise<Response> {
  return fetch(`${baseUrl}/notifications${path}`, {
    method,
    headers: {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: originHeader,
      'X-Athlentry-Request': '1',
    },
  });
}

function aliasRequest(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: origin,
      'X-Athlentry-Request': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('notification HTTP tenancy', () => {
  it('shows only the signed-in account inbox and hides another organization', async () => {
    const own = await request(`/orgs/${ownOrgId}/inbox`);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({
      items: [{ id: ownNotificationId }],
    });

    const other = await request(`/orgs/${otherOrgId}/inbox`);
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const preferences = await request(`/orgs/${otherOrgId}/preferences`);
    expect(preferences.status).toBe(404);
  });

  it('hides cross-tenant notification ids and rejects unverified writes', async () => {
    const crossTenant = await request(
      `/orgs/${ownOrgId}/inbox/${otherNotificationId}/read`,
      'PATCH',
    );
    expect(crossTenant.status).toBe(404);
    const badOrigin = await request(
      `/orgs/${ownOrgId}/inbox/${ownNotificationId}/read`,
      'PATCH',
      'https://elsewhere.invalid',
    );
    expect(badOrigin.status).toBe(403);
    const own = await request(
      `/orgs/${ownOrgId}/inbox/${ownNotificationId}/read`,
      'PATCH',
    );
    expect(own.status).toBe(200);
    expect(await own.json()).toHaveProperty('readAt');
  });

  it('mounts account and organization aliases with the same tenant boundary', async () => {
    const orgInbox = await aliasRequest(`/orgs/${ownOrgId}/notifications`);
    expect(orgInbox.status).toBe(200);
    expect(await orgInbox.json()).toMatchObject({
      items: [{ id: ownNotificationId }],
    });
    const accountInbox = await aliasRequest(
      `/me/notifications?orgId=${ownOrgId}`,
    );
    expect(accountInbox.status).toBe(200);
    expect(await accountInbox.json()).toMatchObject({
      items: [{ id: ownNotificationId }],
    });
    expect(
      (await aliasRequest(`/me/notifications/orgs/${ownOrgId}/inbox`)).status,
    ).toBe(200);
    expect(
      (await aliasRequest(`/orgs/${ownOrgId}/notifications/inbox`)).status,
    ).toBe(200);
    expect((await aliasRequest('/me/notifications')).status).toBe(400);
    expect(
      (await aliasRequest(`/me/notifications?orgId=${otherOrgId}`)).status,
    ).toBe(404);
    expect(
      (await aliasRequest(`/orgs/${otherOrgId}/notifications`)).status,
    ).toBe(404);
    expect(
      (await aliasRequest(`/orgs/${ownOrgId}/notification-preferences`)).status,
    ).toBe(200);
    expect(
      (await aliasRequest(`/me/notification-preferences?orgId=${ownOrgId}`))
        .status,
    ).toBe(200);
    const marked = await aliasRequest(
      `/me/notifications/${ownNotificationId}/read?orgId=${ownOrgId}`,
      'PATCH',
    );
    expect(marked.status).toBe(200);
    const preference = await aliasRequest(
      `/me/notification-preferences/marketing/email?orgId=${ownOrgId}`,
      'PUT',
      { enabled: true, expectedVersion: 0 },
    );
    expect(preference.status).toBe(200);
    expect(await preference.json()).toMatchObject({
      enabled: true,
      version: 1,
    });
  });

  it('blocks account and organization aliases when a member organization is suspended', async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query('UPDATE organizations SET status = $1 WHERE id = $2', [
        'suspended',
        ownOrgId,
      ]);
      expect(
        (await aliasRequest(`/me/notifications?orgId=${ownOrgId}`)).status,
      ).toBe(403);
      expect(
        (await aliasRequest(`/orgs/${ownOrgId}/notifications`)).status,
      ).toBe(403);
    } finally {
      await admin.query('UPDATE organizations SET status = $1 WHERE id = $2', [
        'active',
        ownOrgId,
      ]);
      await admin.end();
    }
  });
});
