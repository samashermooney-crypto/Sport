import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { federationCapabilitiesSchema } from '@shared/schemas/federation';
import { federationBootstrapResources } from '@web/console/federation/access';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createDatabase } from '../src/db/kysely';
import { createWithOrg } from '../src/db/withOrg';
import { FakeEmailSender } from '../src/integrations/email/sender';
import { MemoryStorage } from '../src/integrations/storage/storage';
import { parseEncryptionKeys } from '../src/lib/crypto';
import type { AuthDependencies } from '../src/modules/auth/routes';
import { issueSession } from '../src/modules/auth/sessions';
import {
  getFederationAdminDatabase,
  resetFederationAdminDatabase,
} from '../src/modules/federation/privileged';

import { createTestFactories, type ActorFixture } from './factories';

const now = new Date('2026-09-29T18:00:00.000Z');
const appUrl = 'http://127.0.0.1:5173';
const encryption = parseEncryptionKeys(
  JSON.stringify({ test: randomBytes(32).toString('base64') }),
  'test',
);
let database: ReturnType<typeof createDatabase>;
let server: Server;
let baseUrl: string;
let previousDatabaseUrl: string | undefined;
let previousAdminDatabaseUrl: string | undefined;
const factories = () => createTestFactories(database);

type SignedInActor = ActorFixture & { token: string };

async function makeRole(role: string): Promise<SignedInActor> {
  const actor = await factories().actor();
  await createWithOrg(database)(actor, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ role, pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .where('account_id', '=', actor.accountId)
      .execute()
      .then(() => undefined),
  );
  const session = await database.transaction().execute((trx) =>
    issueSession(
      trx,
      {
        accountId: actor.accountId,
        kind: 'cookie',
        client: 'web',
        privileged: true,
        mfaVerifiedAt: now,
      },
      now,
    ),
  );
  return { ...actor, token: session.token };
}

async function getFor(
  actor: SignedInActor,
  resource: string,
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/v1/federation/organizations/${actor.orgId}/${resource}`,
    {
      headers: { Cookie: `__Host-athlentry_session=${actor.token}` },
    },
  );
}

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousAdminDatabaseUrl = process.env.DATABASE_ADMIN_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
  process.env.DATABASE_ADMIN_URL = process.env.TEST_DATABASE_URL;
  resetFederationAdminDatabase();
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');

  const auth = {
    database,
    email: new FakeEmailSender(),
    encryption,
    appUrl,
    clock: () => now,
    localStorage: new MemoryStorage(),
    captchaWidget: { mode: 'preview' as const },
    pushPublicKey: '',
  } as unknown as AuthDependencies;
  server = createApp(auth).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  await database.destroy();
  await getFederationAdminDatabase().destroy();
  resetFederationAdminDatabase();
  if (previousDatabaseUrl === undefined)
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousAdminDatabaseUrl === undefined)
    Reflect.deleteProperty(process.env, 'DATABASE_ADMIN_URL');
  else process.env.DATABASE_ADMIN_URL = previousAdminDatabaseUrl;
});

describe('federation console API capabilities', () => {
  it('lets every crawler role fetch only the federation resources allowed by its capabilities', async () => {
    const crawlerRoles = [
      'owner',
      'admin',
      'registrar',
      'finance',
      'scheduler',
      'compliance',
      'communications',
      'director',
      'evaluator',
      'volunteer_coordinator',
      'reporter',
    ];

    for (const role of crawlerRoles) {
      const actor = await makeRole(role);
      const response = await getFor(actor, 'capabilities');
      expect(response.status, `${role} GET capabilities`).toBe(200);
      const capabilities = federationCapabilitiesSchema.parse(
        await response.json(),
      );
      const allowedResources = federationBootstrapResources.filter(
        (resource) => capabilities[resource.capability],
      );

      const results = await Promise.all(
        allowedResources.map(async ({ endpoint }) => ({
          endpoint,
          status: (await getFor(actor, endpoint)).status,
        })),
      );
      for (const result of results)
        expect(
          result.status,
          `${role} GET ${result.endpoint} allowed by capabilities`,
        ).toBe(200);
    }
  }, 60_000);

  it('matches bootstrap API access to each actor role without widening protected reads', async () => {
    const finance = await makeRole('finance');
    const capabilityResponse = await getFor(finance, 'capabilities');
    expect(capabilityResponse.status).toBe(200);
    expect(await capabilityResponse.json()).toEqual({
      relationships: true,
      manageRelationships: false,
      directory: true,
      submitEntries: false,
      schedule: false,
      discipline: false,
      referees: false,
      finance: true,
    });

    const financeBootstrap = [
      ['relationships', 200],
      ['programs', 200],
      ['members', 200],
      ['entries', 200],
      ['submitted-entries', 404],
      ['my-teams', 404],
      ['my-spaces', 404],
      ['hosted-games', 404],
      ['space-contributions', 404],
      ['referees', 404],
      ['referee-assignments', 404],
      ['fees', 200],
      ['member-payers', 200],
      ['federation-discipline', 404],
      ['member-discipline', 200],
      ['schedule-runs', 404],
      ['dashboard', 200],
    ] as const;
    for (const [resource, status] of financeBootstrap) {
      const response = await getFor(finance, resource);
      expect(response.status, `finance GET ${resource}`).toBe(status);
    }

    const registrar = await makeRole('registrar');
    const registrarCapabilities = await getFor(registrar, 'capabilities');
    expect(registrarCapabilities.status).toBe(200);
    expect(await registrarCapabilities.json()).toEqual({
      relationships: true,
      manageRelationships: false,
      directory: false,
      submitEntries: true,
      schedule: false,
      discipline: false,
      referees: false,
      finance: false,
    });
    expect((await getFor(registrar, 'relationships')).status).toBe(200);
    expect((await getFor(registrar, 'submitted-entries')).status).toBe(200);
    expect((await getFor(registrar, 'members')).status).toBe(404);
  });
});
