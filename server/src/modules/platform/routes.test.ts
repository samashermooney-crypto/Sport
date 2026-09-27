import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import express from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { AuthDependencies } from '../auth/routes';

import { getPlatformAdminDatabase } from './admin';
import { createPlatformRouter } from './routes';

const origin = 'http://127.0.0.1:5173';
const now = new Date('2026-09-26T18:00:00Z');
const orgId = randomUUID();
const roles = ['super_admin', 'support', 'outsider', 'no_mfa'] as const;
const accounts = Object.fromEntries(
  roles.map((role) => [
    role,
    { id: randomUUID(), token: randomBytes(32).toString('base64url') },
  ]),
) as Record<(typeof roles)[number], { id: string; token: string }>;
let database: ReturnType<typeof createDatabase>;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let previousAdminUrl: string | undefined;

beforeAll(async () => {
  previousAdminUrl = process.env.DATABASE_ADMIN_URL;
  process.env.DATABASE_ADMIN_URL = process.env.TEST_DATABASE_URL;
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const role of roles) {
      const account = accounts[role];
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [
          account.id,
          `${account.id}@example.invalid`,
          'Platform',
          'Tester',
          '1990-01-01',
        ],
      );
      await admin.query(
        `INSERT INTO sessions(id,token_hash,account_id,kind,client,privileged,mfa_verified_at,idle_expires_at,absolute_expires_at)
         VALUES ($1,$2,$3,'cookie','web',true,$4,$5,$6)`,
        [
          randomUUID(),
          createHash('sha256').update(account.token).digest(),
          account.id,
          role === 'no_mfa' ? null : now,
          new Date(now.getTime() + 60 * 60 * 1000),
          new Date(now.getTime() + 24 * 60 * 60 * 1000),
        ],
      );
    }
    await admin.query(
      'INSERT INTO platform_staff(account_id,role) VALUES ($1,$2),($3,$4),($5,$6)',
      [
        accounts.super_admin.id,
        'super_admin',
        accounts.support.id,
        'support',
        accounts.no_mfa.id,
        'support',
      ],
    );
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        orgId,
        `platform-http-${orgId.slice(0, 8)}`,
        'HTTP Club',
        'club',
        'UTC',
        'active',
      ],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const app = express();
  app.use(
    '/api/v1/platform',
    createPlatformRouter({
      database,
      appUrl: origin,
      clock: () => now,
    } as AuthDependencies),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/platform`;
});

afterAll(async () => {
  server.close();
  await database.destroy();
  await getPlatformAdminDatabase().destroy();
  if (previousAdminUrl === undefined) delete process.env.DATABASE_ADMIN_URL;
  else process.env.DATABASE_ADMIN_URL = previousAdminUrl;
});

function request(
  role: (typeof roles)[number],
  path: string,
  options: { method?: string; body?: unknown; origin?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Cookie: `__Host-athlentry_session=${accounts[role].token}`,
      Origin: options.origin ?? origin,
      'X-Athlentry-Request': '1',
      ...(options.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

describe('platform HTTP permissions', () => {
  it('requires active staff and MFA before exposing global data', async () => {
    expect((await request('outsider', '/me')).status).toBe(403);
    expect((await request('no_mfa', '/me')).status).toBe(403);
    expect((await request('support', '/me')).status).toBe(200);
    const orgs = await request('support', '/orgs');
    expect(orgs.status).toBe(200);
    expect(await orgs.json()).toMatchObject({ items: [{ id: orgId }] });
  });

  it('limits suspension to super admins and rejects stale versions', async () => {
    const path = `/orgs/${orgId}/status`;
    const body = { status: 'suspended', expectedVersion: 1 };
    expect(
      (await request('support', path, { method: 'PATCH', body })).status,
    ).toBe(403);
    expect(
      (
        await request('super_admin', path, {
          method: 'PATCH',
          body,
          origin: 'https://elsewhere.invalid',
        })
      ).status,
    ).toBe(403);
    const updated = await request('super_admin', path, {
      method: 'PATCH',
      body,
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      status: 'suspended',
      version: 2,
    });
    const stale = await request('super_admin', path, { method: 'PATCH', body });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });
});
