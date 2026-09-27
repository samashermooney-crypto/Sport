import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import { createDatabase } from '../../src/db/kysely';
import { AlwaysPassCaptcha } from '../../src/integrations/captcha/provider';
import { FakeEmailSender } from '../../src/integrations/email/sender';
import { parseEncryptionKeys } from '../../src/lib/crypto';
import { createAuthRateLimits } from '../../src/modules/auth/rate-limits';
import type { AuthRateLimits } from '../../src/modules/auth/rate-limits';

const origin = 'http://127.0.0.1:5173';
const databaseUrl = process.env.TEST_DATABASE_APP_URL ?? '';
const email = new FakeEmailSender();
const encryption = parseEncryptionKeys(
  JSON.stringify({ test: randomBytes(32).toString('base64') }),
  'test',
);
let database: ReturnType<typeof createDatabase>;
let rateLimits: AuthRateLimits;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  rateLimits = createAuthRateLimits(databaseUrl);
  server = createApp({
    database,
    rateLimits,
    email,
    encryption,
    captcha: new AlwaysPassCaptcha(),
    captchaWidget: { mode: 'preview' },
    pushPublicKey: 'test-public-key',
    appUrl: origin,
    clock: () => new Date('2026-09-27T16:00:00Z'),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => {
    server.once('listening', () => {
      resolve();
    });
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/auth`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await rateLimits.close();
  await database.destroy();
});

const signup = {
  email: 'csrf@example.invalid',
  password: 'safe season sports 38',
  firstName: 'CSRF',
  lastName: 'Security',
  dateOfBirth: '2000-01-01',
  termsAccepted: true,
  privacyAccepted: true,
  captchaToken: 'test-token',
};

describe('CSRF protection on cookie-style mutations', () => {
  it('rejects a mutation without X-Athlentry-Request', async () => {
    const response = await fetch(`${baseUrl}/sign-up`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify(signup),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
  });

  it('rejects a cookie-style mutation without Origin', async () => {
    const response = await fetch(`${baseUrl}/sign-up`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Athlentry-Request': '1',
      },
      body: JSON.stringify(signup),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(email.messages).toHaveLength(0);
  });
});
