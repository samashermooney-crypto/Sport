import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import { FakeEmailSender } from '../src/integrations/email/sender';
import { MemoryStorage } from '../src/integrations/storage/storage';
import { parseEncryptionKeys } from '../src/lib/crypto';
import type { AuthDependencies } from '../src/modules/auth/routes';
import { issueSession } from '../src/modules/auth/sessions';
import { moduleDefinition } from '../src/modules/compliance/module';

import { createTestFactories } from './factories';

const origin = 'http://127.0.0.1:5173';
const now = new Date('2026-09-29T18:00:00.000Z');
const encryption = parseEncryptionKeys(
  JSON.stringify({ test: randomBytes(32).toString('base64') }),
  'test',
);
const email = new FakeEmailSender();
let database: ReturnType<typeof createDatabase>;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let orgId: string;
let personId: string;
let ownerToken: string;
let ownerTokenNoStepUp: string;
let cardProgramId: string;
const cardStorage = new MemoryStorage();
const cardPhotoBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const cardPhotoFileId = randomUUID();
const cardPhotoStorageKey = `compliance-route/${cardPhotoFileId}.jpg`;
const checkrWebhookSecret = 'test-checkr-webhook-secret';
const previousCheckrEnvironment = {
  enabled: process.env.CHECKR_ENABLED,
  apiKey: process.env.CHECKR_API_KEY,
  baseUrl: process.env.CHECKR_BASE_URL,
};

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

type OpenApiRoute = {
  method: 'get' | 'post' | 'patch';
  path: string;
  public?: boolean;
};

async function request(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; validOrigin?: boolean } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.token
        ? { Cookie: `__Host-athlentry_session=${options.token}` }
        : {}),
      ...(options.validOrigin === false
        ? { Origin: 'https://attacker.example' }
        : { Origin: origin }),
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

function concretePath(path: string): string {
  return path
    .replace('/api/v1/compliance', '')
    .replaceAll('{orgId}', orgId)
    .replaceAll('{personId}', personId)
    .replaceAll('{credentialTypeId}', randomUUID())
    .replaceAll('{requirementId}', randomUUID())
    .replaceAll('{credentialId}', randomUUID())
    .replaceAll('{orderId}', randomUUID())
    .replaceAll('{disputeId}', randomUUID())
    .replaceAll('{cardId}', randomUUID())
    .replaceAll('{token}', 'x'.repeat(40));
}

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const factories = createTestFactories(database);
  const owner = await factories.actor();
  orgId = owner.orgId;
  personId = await factories.person(owner, {
    firstName: 'Alex',
    lastName: 'Athlete',
    dateOfBirth: '2012-02-29',
  });
  const cardProgram = await factories.program(owner);
  cardProgramId = cardProgram.programId;
  const cardTeam = await factories.team(owner, cardProgram);
  await factories.row(owner, 'roster_entries', {
    id: randomUUID(),
    org_id: owner.orgId,
    team_season_id: cardTeam.teamSeasonId,
    person_id: personId,
    status: 'active',
  });
  await factories.scoped(owner, (trx) =>
    trx
      .updateTable('people')
      .set({ media_consent: 'granted' })
      .where('id', '=', personId)
      .execute()
      .then(() => undefined),
  );
  await factories.row(owner, 'files', {
    id: cardPhotoFileId,
    org_id: owner.orgId,
    purpose: 'image',
    owner_type: 'person',
    owner_id: personId,
    storage_key: cardPhotoStorageKey,
    mime: 'image/jpeg',
    bytes: cardPhotoBytes.byteLength,
    sensitivity: 'restricted',
    created_by: owner.accountId,
    upload_state: 'complete',
  });
  await cardStorage.put(cardPhotoStorageKey, cardPhotoBytes, 'image/jpeg');
  await factories.scoped(owner, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', orgId)
      .where('account_id', '=', owner.accountId)
      .execute()
      .then(() => undefined),
  );
  const issued = await database.transaction().execute((trx) =>
    issueSession(
      trx,
      {
        accountId: owner.accountId,
        kind: 'cookie',
        client: 'web',
        privileged: true,
        mfaVerifiedAt: now,
      },
      now,
    ),
  );
  ownerToken = issued.token;
  await database
    .updateTable('sessions')
    .set({ elevated_until: new Date(now.getTime() + 60 * 60 * 1000) })
    .where('id', '=', issued.id)
    .execute();
  ownerTokenNoStepUp = (
    await database.transaction().execute((trx) =>
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
    )
  ).token;

  const app = express();
  process.env.CHECKR_ENABLED = 'true';
  process.env.CHECKR_API_KEY = checkrWebhookSecret;
  process.env.CHECKR_BASE_URL = 'https://api.checkr-staging.com';
  const router = moduleDefinition.router({
    database,
    encryption,
    email,
    appUrl: origin,
    clock: () => now,
    localStorage: cardStorage,
  } as unknown as AuthDependencies);
  restoreEnvironment('CHECKR_ENABLED', previousCheckrEnvironment.enabled);
  restoreEnvironment('CHECKR_API_KEY', previousCheckrEnvironment.apiKey);
  restoreEnvironment('CHECKR_BASE_URL', previousCheckrEnvironment.baseUrl);
  app.use(moduleDefinition.path, router);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${moduleDefinition.path}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await cardStorage.delete(cardPhotoStorageKey);
  await database.destroy();
});

describe('compliance module HTTP surface', () => {
  it('validates environment configuration and publishes each route contract', () => {
    expect(moduleDefinition.configSchema.parse({ NODE_ENV: 'test' })).toEqual({
      NODE_ENV: 'test',
    });
    expect(
      moduleDefinition.configSchema.safeParse({ CHECKR_ENABLED: 'true' })
        .success,
    ).toBe(false);
    expect(
      moduleDefinition.configSchema.safeParse({
        NODE_ENV: 'test',
        CHECKR_ENABLED: 'true',
        CHECKR_API_KEY: 'test-key',
        CHECKR_BASE_URL: 'https://api.checkr.com',
      }).success,
    ).toBe(false);
    expect(moduleDefinition.openapiRoutes.length).toBeGreaterThan(25);
  });

  it('requires a session on every protected route and keeps public verification private', async () => {
    const routes = moduleDefinition.openapiRoutes as readonly OpenApiRoute[];
    for (const route of routes) {
      const response = await request(
        route.method.toUpperCase(),
        concretePath(route.path),
        {
          body: route.method === 'get' ? undefined : {},
        },
      );
      if (route.public) {
        expect(response.status, route.path).toBeLessThan(500);
      } else {
        expect(response.status, route.path).toBe(401);
      }
    }
  });

  it('dispatches authenticated requests with origin and schema checks', async () => {
    const routes = moduleDefinition.openapiRoutes as readonly OpenApiRoute[];
    for (const route of routes.filter((item) => !item.public)) {
      const body = route.method === 'get' ? undefined : {};
      const response = await request(
        route.method.toUpperCase(),
        concretePath(route.path),
        { token: ownerToken, body },
      );
      expect(response.status, route.path).toBeLessThan(500);
      expect(response.headers.get('cache-control'), route.path).toBe(
        'no-store',
      );
      expect(response.headers.get('referrer-policy'), route.path).toBe(
        'no-referrer',
      );
    }

    const invalidOrigin = await request(
      'POST',
      `/organizations/${orgId}/requirements`,
      { token: ownerToken, body: {}, validOrigin: false },
    );
    expect(invalidOrigin.status).toBe(403);

    const invalidCardAction = await request(
      'PATCH',
      `/organizations/${orgId}/cards/${randomUUID()}`,
      {
        token: ownerToken,
        body: { status: 'active', version: 1 },
      },
    );
    expect(invalidCardAction.status).toBe(400);

    const notElevated = await request(
      'PATCH',
      `/organizations/${orgId}/background-check-settings`,
      { token: ownerTokenNoStepUp, body: {} },
    );
    expect(notElevated.status).toBe(403);
    const adjudicationStepUp = await request(
      'POST',
      `/organizations/${orgId}/background-checks/${randomUUID()}/adjudication`,
      {
        token: ownerTokenNoStepUp,
        body: {
          adjudication: 'eligible',
          reason: 'Verify elevated session gating.',
          version: 1,
        },
      },
    );
    expect(adjudicationStepUp.status).toBe(403);

    const createdCard = await request('POST', `/organizations/${orgId}/cards`, {
      token: ownerToken,
      body: {
        personId,
        cardKind: 'player',
        programId: cardProgramId,
        cardNumber: 'ROUTE-PLAYER',
        validUntil: '2026-11-30',
        photoFileId: cardPhotoFileId,
      },
    });
    expect(createdCard.status).toBe(201);
    const card = (await createdCard.json()) as { id: string; token: string };
    const verifiedCard = await request('GET', `/cards/verify/${card.token}`);
    expect(verifiedCard.status).toBe(200);
    expect(await verifiedCard.json()).toMatchObject({ photoAvailable: true });
    const photo = await request('GET', `/cards/verify/${card.token}/photo`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toContain('image/jpeg');
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(cardPhotoBytes);
    const revoked = await request(
      'PATCH',
      `/organizations/${orgId}/cards/${card.id}`,
      { token: ownerToken, body: { status: 'revoked', version: 1 } },
    );
    expect(revoked.status).toBe(200);

    const ignoredEvent = JSON.stringify({
      id: 'evt_ignored',
      type: 'report.updated',
    });
    const ignoredSignature = createHmac('sha256', checkrWebhookSecret)
      .update(ignoredEvent)
      .digest('hex');
    const ignoredWebhook = await fetch(`${baseUrl}/webhooks/checkr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Checkr-Signature': ignoredSignature,
      },
      body: ignoredEvent,
    });
    expect(ignoredWebhook.status).toBe(202);
    expect(await ignoredWebhook.json()).toEqual({
      received: true,
      ignored: true,
    });
    const invalidWebhook = await fetch(`${baseUrl}/webhooks/checkr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Checkr-Signature': 'bad-signature',
      },
      body: ignoredEvent,
    });
    expect(invalidWebhook.status).toBe(401);
    const incompleteWebhookBody = JSON.stringify({
      id: 'evt_incomplete',
      type: 'report.completed',
    });
    const incompleteWebhookSignature = createHmac('sha256', checkrWebhookSecret)
      .update(incompleteWebhookBody)
      .digest('hex');
    const incompleteWebhook = await fetch(`${baseUrl}/webhooks/checkr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Checkr-Signature': incompleteWebhookSignature,
      },
      body: incompleteWebhookBody,
    });
    expect(incompleteWebhook.status).toBe(503);
  });
});
