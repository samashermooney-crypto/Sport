import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createDatabase } from '../src/db/kysely';
import { AlwaysPassCaptcha } from '../src/integrations/captcha/provider';
import { FakeEmailSender } from '../src/integrations/email/sender';
import { parseEncryptionKeys } from '../src/lib/crypto';
import { createAuthRateLimits } from '../src/modules/auth/rate-limits';
import { issueSession } from '../src/modules/auth/sessions';

import { createTestFactories } from './factories';

const origin = 'http://127.0.0.1:5173';
const now = new Date('2026-09-26T18:00:00Z');
let database: ReturnType<typeof createDatabase>;
let rateLimits: ReturnType<typeof createAuthRateLimits>;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;
let orgA = '';
let orgB = '';
let credentialA = '';
let credentialB = '';
let cookie = '';
let accountA = '';
let sessionId = '';

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  rateLimits = createAuthRateLimits(process.env.TEST_DATABASE_APP_URL ?? '');
  const factory = createTestFactories(database);
  const actorA = await factory.actor();
  const actorB = await factory.actor();
  orgA = actorA.orgId;
  orgB = actorB.orgId;
  accountA = actorA.accountId;
  credentialA = newId();
  credentialB = newId();
  for (const [actor, id] of [
    [actorA, credentialA],
    [actorB, credentialB],
  ] as const) {
    await factory.scoped(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('account_id', '=', actor.accountId)
        .execute();
      await trx
        .insertInto('credential_types')
        .values({
          id,
          org_id: actor.orgId,
          key: 'background_check',
          name: 'Background check',
          verification: 'manual_staff',
          validity: { months: 12 },
          applies_to: { roles: ['head_coach'] },
          blocks_activation: true,
        })
        .execute();
    });
  }
  const issued = await database.transaction().execute((trx) =>
    issueSession(
      trx,
      {
        accountId: actorA.accountId,
        kind: 'cookie',
        client: 'web',
        privileged: true,
        mfaVerifiedAt: now,
      },
      now,
    ),
  );
  sessionId = issued.id;
  await database
    .updateTable('sessions')
    .set({ elevated_until: new Date(now.getTime() + 600_000) })
    .where('id', '=', issued.id)
    .execute();
  cookie = `__Host-athlentry_session=${issued.token}`;
  server = createApp({
    database,
    rateLimits,
    email: new FakeEmailSender(),
    encryption: parseEncryptionKeys(
      JSON.stringify({ k1: randomBytes(32).toString('base64') }),
      'k1',
    ),
    captcha: new AlwaysPassCaptcha(),
    captchaWidget: { mode: 'preview' },
    pushPublicKey: 'test-public-key',
    appUrl: origin,
    clock: () => now,
  }).listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/orgs`;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  await rateLimits.close();
  await database.destroy();
});

function request(
  orgId: string,
  id?: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/${orgId}/credential-types${id ? `/${id}` : ''}`, {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-Athlentry-Request': '1',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('organization safety credential HTTP contract', () => {
  it('hides other tenants and protects writes with versions and step-up', async () => {
    const own = await request(orgA);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject([
      { id: credentialA, active: true, version: 1 },
    ]);
    expect((await request(orgB)).status).toBe(404);
    const body = {
      name: 'Background review',
      validityMonths: 12,
      blocksActivation: true,
      active: false,
      version: 1,
    };
    expect((await request(orgA, credentialB, body)).status).toBe(404);
    expect(
      (await request(orgA, credentialA, { ...body, version: 2 })).status,
    ).toBe(409);
    const updated = await request(orgA, credentialA, body);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      id: credentialA,
      active: false,
      version: 2,
    });
    expect((await request(orgA, credentialA, body)).status).toBe(409);
    const audit = await createTestFactories(database).scoped(
      { orgId: orgA, accountId: accountA, actor: { accountId: accountA } },
      (trx) =>
        trx
          .selectFrom('audit_log')
          .select('action')
          .where('entity_id', '=', credentialA)
          .execute(),
    );
    expect(audit).toMatchObject([{ action: 'credential_type.updated' }]);
    await database
      .updateTable('sessions')
      .set({ elevated_until: new Date(now.getTime() - 1) })
      .where('id', '=', sessionId)
      .execute();
    expect(
      (await request(orgA, credentialA, { ...body, version: 2 })).status,
    ).toBe(403);
  });
});
