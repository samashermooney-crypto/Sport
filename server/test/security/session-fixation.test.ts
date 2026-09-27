import { randomBytes, randomUUID } from 'node:crypto';
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
const password = 'safe season sports 38';
const email = new FakeEmailSender();
const encryption = parseEncryptionKeys(
  JSON.stringify({ test: randomBytes(32).toString('base64') }),
  'test',
);
const now = new Date('2026-09-27T16:00:00Z');
let database: ReturnType<typeof createDatabase>;
let rateLimits: AuthRateLimits;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;

beforeAll(() => {
  const url = process.env.TEST_DATABASE_APP_URL ?? '';
  database = createDatabase(url);
  rateLimits = createAuthRateLimits(url);
  server = createApp({
    database,
    rateLimits,
    email,
    encryption,
    captcha: new AlwaysPassCaptcha(),
    captchaWidget: { mode: 'preview' },
    pushPublicKey: 'test-public-key',
    appUrl: origin,
    clock: () => now,
  }).listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/auth`;
});

afterAll(async () => {
  server.close();
  await rateLimits.close();
  await database.destroy();
});

async function post(
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Athlentry-Request': '1',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('session fixation and cookie invalidation', () => {
  it('rotates an attacker-supplied pre-auth cookie and invalidates logout server-side', async () => {
    const accountEmail = `fixation-${randomUUID()}@example.invalid`;
    const signup = await post('/sign-up', {
      email: accountEmail,
      password,
      firstName: 'Session',
      lastName: 'Security',
      dateOfBirth: '2000-01-01',
      termsAccepted: true,
      privacyAccepted: true,
      captchaToken: 'test-token',
    });
    expect(signup.status).toBe(202);
    const verificationToken = email.messages[0]?.text.match(
      /\/verify\/([A-Za-z0-9_-]{43})/,
    )?.[1];
    expect(verificationToken).toBeTruthy();
    if (!verificationToken)
      throw new Error('Verification token was not issued');
    expect(
      (await post('/verify-email', { token: verificationToken })).status,
    ).toBe(200);

    const attackerToken = 'A'.repeat(43);
    const preAuthCookie = `__Host-athlentry_session=${attackerToken}`;
    const signIn = await post(
      '/sign-in',
      { email: accountEmail, password },
      preAuthCookie,
    );
    expect(signIn.status).toBe(200);
    const setCookie = signIn.headers.get('set-cookie');
    expect(setCookie).toContain('__Host-athlentry_session=');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Domain=');
    const issuedCookie = setCookie?.split(';')[0];
    if (!issuedCookie)
      throw new Error('Sign-in did not issue a session cookie');
    expect(issuedCookie).not.toBe(preAuthCookie);
    expect(
      (await fetch(`${baseUrl}/me`, { headers: { Cookie: issuedCookie } }))
        .status,
    ).toBe(200);
    expect(
      (await fetch(`${baseUrl}/me`, { headers: { Cookie: preAuthCookie } }))
        .status,
    ).toBe(401);

    expect((await post('/sign-out', {}, issuedCookie)).status).toBe(200);
    expect(
      (await fetch(`${baseUrl}/me`, { headers: { Cookie: issuedCookie } }))
        .status,
    ).toBe(401);
  });
});
