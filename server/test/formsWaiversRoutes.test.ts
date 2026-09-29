import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import { parseEncryptionKeys } from '../src/lib/crypto';
import type { AuthDependencies } from '../src/modules/auth/routes';
import { issueSession } from '../src/modules/auth/sessions';
import { moduleDefinition as formsModule } from '../src/modules/forms/module';
import { moduleDefinition as waiversModule } from '../src/modules/waivers/module';

import { createTestFactories } from './factories';

const appUrl = 'http://127.0.0.1:5173';
const now = new Date('2026-09-27T18:00:00Z');
let database: ReturnType<typeof createDatabase>;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let ownerOrgId = '';
let otherOrgId = '';
let ownerCookie = '';

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const factories = createTestFactories(database);
  const owner = await factories.actor();
  const other = await factories.actor();
  ownerOrgId = owner.orgId;
  otherOrgId = other.orgId;
  await factories.scoped(owner, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', owner.orgId)
      .where('account_id', '=', owner.accountId)
      .execute()
      .then(() => undefined),
  );
  const session = await database.transaction().execute((trx) =>
    issueSession(
      trx,
      {
        accountId: owner.accountId,
        kind: 'cookie',
        client: 'web',
        privileged: false,
      },
      now,
    ),
  );
  ownerCookie = `__Host-athlentry_session=${session.token}`;

  const dependencies = {
    database,
    encryption: parseEncryptionKeys(
      JSON.stringify({ test: randomBytes(32).toString('base64') }),
      'test',
    ),
    appUrl,
    clock: () => now,
  } as AuthDependencies;
  const app = express();
  app.use(formsModule.path, formsModule.router(dependencies));
  app.use(waiversModule.path, waiversModule.router(dependencies));
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await database.destroy();
});

function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { Cookie: ownerCookie },
  });
}

function post(path: string, body: unknown, origin = appUrl): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Cookie: ownerCookie,
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Athlentry-Request': '1',
    },
    body: JSON.stringify(body),
  });
}

describe('forms and waivers module routers', () => {
  it('mounts the forms module contract and enforces session, origin and tenant scope', async () => {
    expect(formsModule).toMatchObject({
      name: 'forms',
      path: '/api/v1/forms',
    });
    expect(formsModule.openapiRoutes).toHaveLength(8);

    const unauthorized = await fetch(
      `${baseUrl}/api/v1/forms/orgs/${ownerOrgId}`,
    );
    expect(unauthorized.status).toBe(401);

    const invalidOrigin = await post(
      `/api/v1/forms/orgs/${ownerOrgId}`,
      { name: 'Intake', scope: 'person_profile', schema: { fields: [] } },
      'https://attacker.example',
    );
    expect(invalidOrigin.status).toBe(403);

    const created = await post(`/api/v1/forms/orgs/${ownerOrgId}`, {
      name: 'Athlete intake',
      scope: 'person_profile',
      schema: { fields: [] },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const definition = (await created.json()) as { id: string; name: string };
    expect(definition.name).toBe('Athlete intake');

    const list = await get(`/api/v1/forms/orgs/${ownerOrgId}`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [{ id: definition.id, name: 'Athlete intake' }],
    });
    expect((await get(`/api/v1/forms/orgs/${otherOrgId}`)).status).toBe(404);
  });

  it('mounts the waiver module contract and keeps writes origin protected and tenant scoped', async () => {
    expect(waiversModule).toMatchObject({
      name: 'waivers',
      path: '/api/v1/waivers',
    });
    expect(waiversModule.openapiRoutes).toHaveLength(8);

    const created = await post(`/api/v1/waivers/orgs/${ownerOrgId}`, {
      name: 'Season waiver',
      bodyText:
        'I acknowledge the rules and agree to participate in this season.',
      requires: 'guardian_if_minor',
      renewal: 'annual_season',
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const document = (await created.json()) as { id: string; name: string };
    expect(document.name).toBe('Season waiver');

    const list = await get(`/api/v1/waivers/orgs/${ownerOrgId}`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [{ id: document.id, name: 'Season waiver' }],
    });
    expect((await get(`/api/v1/waivers/orgs/${otherOrgId}`)).status).toBe(404);
  });
});
