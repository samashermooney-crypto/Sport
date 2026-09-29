import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';

const origin = 'http://127.0.0.1:5173';
const now = new Date('2026-09-27T12:00:00Z');
const accountA = randomUUID();
const accountB = randomUUID();
const orgA = randomUUID();
const orgB = randomUUID();
const memberB = randomUUID();
const notificationB = randomUUID();
const token = randomBytes(32).toString('base64url');
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;
let previousDatabaseUrl: string | undefined;

type Operation = { method: string; path: string };
const openapi = JSON.parse(readFileSync('docs/api/openapi.json', 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};
const phaseOnePrefixes = [
  '/api/v1/audit/orgs/',
  '/api/v1/notifications/orgs/',
  '/api/v1/me/notifications/orgs/',
];
const phaseOneOrgSegments = new Set([
  'workspace',
  'profile',
  'credential-types',
  'members',
  'ownership-transfer',
  'invitations',
  'staff',
  'notifications',
  'notification-preferences',
]);
const operations: Operation[] = Object.entries(openapi.paths).flatMap(
  ([path, methods]) =>
    path.includes('{orgId}') &&
    (phaseOnePrefixes.some((prefix) => path.startsWith(prefix)) ||
      (path.startsWith('/api/v1/orgs/{orgId}/') &&
        phaseOneOrgSegments.has(path.split('/')[5] ?? '')))
      ? Object.keys(methods).map((method) => ({ method, path }))
      : [],
);

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const [id, label] of [
      [accountA, 'A'],
      [accountB, 'B'],
    ] as const) {
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth,email_verified_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, `${id}@example.invalid`, label, 'Tenant', '1980-01-01', now],
      );
    }
    for (const [id, label] of [
      [orgA, 'A'],
      [orgB, 'B'],
    ] as const) {
      await admin.query(
        'INSERT INTO organizations(id,slug,name,kind,timezone) VALUES ($1,$2,$3,$4,$5)',
        [id, `tenancy-${id.slice(0, 8)}`, `Tenant ${label}`, 'club', 'UTC'],
      );
    }
    for (const [id, orgId, accountId] of [
      [randomUUID(), orgA, accountA],
      [memberB, orgB, accountB],
    ] as const) {
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
        [id, orgId, accountId, 'active'],
      );
      await admin.query(
        "INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,'owner','org',false)",
        [randomUUID(), orgId, accountId],
      );
    }
    await admin.query(
      `INSERT INTO sessions(id,token_hash,account_id,kind,client,privileged,idle_expires_at,absolute_expires_at)
       VALUES ($1,$2,$3,'cookie','web',false,$4,$5)`,
      [
        randomUUID(),
        createHash('sha256').update(token).digest(),
        accountA,
        new Date(now.getTime() + 60 * 60 * 1000),
        new Date(now.getTime() + 24 * 60 * 60 * 1000),
      ],
    );
    await admin.query(
      `INSERT INTO notifications(id,org_id,account_id,type,payload)
       VALUES ($1,$2,$3,'registration.confirmed','{}')`,
      [notificationB, orgB, accountB],
    );
  } finally {
    await admin.end();
  }
  const app = createApp({
    database: getDatabase(),
    appUrl: origin,
    clock: () => now,
  } as AuthDependencies);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.close();
  await getDatabase().destroy();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

function requestBody(operation: Operation): unknown {
  if (operation.method === 'get' || operation.method === 'delete')
    return undefined;
  if (operation.path.endsWith('/accept')) return { token: 'x'.repeat(43) };
  if (
    operation.path.endsWith('/preferences/{category}/{channel}') ||
    operation.path.endsWith('/notification-preferences/{category}/{channel}')
  )
    return { enabled: false, expectedVersion: 0 };
  return {};
}

describe('OpenAPI upload contracts', () => {
  it('documents all Phase 15 raw upload content types as binary', () => {
    const operation = openapi.paths[
      '/api/v1/imports/orgs/{orgId}/phase15/batches'
    ]?.['post'] as {
      requestBody?: {
        content?: Record<
          string,
          { schema?: { type?: string; format?: string } }
        >;
      };
    };
    const content = operation.requestBody?.content ?? {};
    expect(Object.keys(content).sort()).toEqual(
      [
        'application/octet-stream',
        'text/csv',
        'application/zip',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ].sort(),
    );
    for (const mediaType of Object.keys(content))
      expect(content[mediaType]?.schema).toEqual({
        type: 'string',
        format: 'binary',
      });
  });
});

describe('Phase 1 tenant route acceptance', () => {
  it('covers the documented organization-addressed route surface', () => {
    expect(operations.length).toBe(32);
    expect(
      new Set(operations.map(({ method, path }) => `${method} ${path}`)).size,
    ).toBe(32);
  });

  it.each(operations)(
    '$method $path hides organization B from A',
    async (operation) => {
      const path = operation.path
        .replace('{orgId}', orgB)
        .replace('{memberId}', memberB)
        .replace('{credentialId}', randomUUID())
        .replace('{invitationId}', randomUUID())
        .replace('{id}', notificationB)
        .replace('{category}', 'marketing')
        .replace('{channel}', 'email');
      const body = requestBody(operation);
      const response = await fetch(`${baseUrl}${path}`, {
        method: operation.method.toUpperCase(),
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: origin,
          'X-Athlentry-Request': '1',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(
        response.status,
        `${operation.method} ${path}: ${await response.text()}`,
      ).toBe(404);
    },
  );

  it.each([
    { method: 'GET', path: '/api/v1/me/notifications' },
    { method: 'PATCH', path: `/api/v1/me/notifications/${notificationB}/read` },
    { method: 'GET', path: '/api/v1/me/notification-preferences' },
    {
      method: 'PUT',
      path: '/api/v1/me/notification-preferences/marketing/email',
    },
  ])(
    '$method $path hides B when the tenant is a query parameter',
    async ({ method, path }) => {
      const response = await fetch(`${baseUrl}${path}?orgId=${orgB}`, {
        method,
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: origin,
          'X-Athlentry-Request': '1',
          ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'PUT'
          ? { body: JSON.stringify({ enabled: false, expectedVersion: 0 }) }
          : {}),
      });
      expect(
        response.status,
        `${method} ${path}: ${await response.text()}`,
      ).toBe(404);
    },
  );

  it('keeps a direct SQL query under withOrg(A) from reading B rows', async () => {
    const database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
    try {
      const rows = await createWithOrg(database)(
        { orgId: orgA, actor: { accountId: accountA } },
        (trx) =>
          trx
            .selectFrom('org_memberships')
            .select('id')
            .where('id', '=', memberB)
            .execute(),
      );
      expect(rows).toEqual([]);
    } finally {
      await database.destroy();
    }
  });
});
