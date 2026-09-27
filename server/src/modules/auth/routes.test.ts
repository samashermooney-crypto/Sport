import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { AlwaysPassCaptcha } from '../../integrations/captcha/provider';
import { FakeEmailSender } from '../../integrations/email/sender';
import { parseEncryptionKeys } from '../../lib/crypto';

import { createAuthRateLimits } from './rate-limits';
import type { AuthRateLimits } from './rate-limits';
import { decodeBase32, totpCode } from './totp';

const origin = 'http://127.0.0.1:5173';
const password = 'safe snow-covered bicycle 44';
const email = new FakeEmailSender();
const encryption = parseEncryptionKeys(
  JSON.stringify({ k1: randomBytes(32).toString('base64') }),
  'k1',
);
const now = new Date('2026-09-26T18:00:00Z');
let database: Kysely<DB>;
let rateLimits: AuthRateLimits;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  rateLimits = createAuthRateLimits(process.env.TEST_DATABASE_APP_URL ?? '');
  server = createApp({
    database,
    rateLimits,
    email,
    encryption,
    captcha: new AlwaysPassCaptcha(),
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
  validOrigin = true,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Athlentry-Request': '1',
      ...(validOrigin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function authCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (!header) throw new Error('Session cookie was not issued');
  expect(header).toContain('Secure');
  expect(header).toContain('HttpOnly');
  expect(header).toContain('SameSite=Lax');
  const cookie = header.split(';')[0];
  if (!cookie) throw new Error('Session cookie is empty');
  return cookie;
}

function emailToken(index: number, path: string): string {
  const token = email.messages[index]?.text.match(
    new RegExp(`/${path}/([A-Za-z0-9_-]{43})`),
  )?.[1];
  if (!token) throw new Error(`Missing ${path} token`);
  return token;
}

describe('auth HTTP contract', () => {
  it('enforces origin, validates input and completes verification, MFA and session flows', async () => {
    const input = {
      email: 'http-owner@example.invalid',
      password,
      firstName: 'HTTP',
      lastName: 'Owner',
      dateOfBirth: '2000-01-01',
      termsAccepted: true,
      privacyAccepted: true,
      captchaToken: 'test-token',
    };
    const blocked = await post('/sign-up', input, undefined, false);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });

    const invalid = await post('/sign-up', { ...input, email: 'not-an-email' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
    const malformed = await fetch(`${baseUrl}/sign-in`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'X-Athlentry-Request': '1',
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    expect(malformed.status).toBe(400);

    const signup = await post('/sign-up', input);
    expect(signup.status).toBe(202);
    expect(email.messages).toHaveLength(1);
    const unverified = await post('/sign-in', { email: input.email, password });
    expect(unverified.status).toBe(403);

    const token = emailToken(0, 'verify');
    expect((await post('/verify-email', { token })).status).toBe(200);
    expect((await post('/verify-email', { token })).status).toBe(422);
    const signedIn = await post('/sign-in', { email: input.email, password });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ status: 'session' });
    const cookie = authCookie(signedIn);

    const enrollment = await post('/mfa/enroll/start', {}, cookie);
    expect(enrollment.status).toBe(200);
    expect(enrollment.headers.get('cache-control')).toBe('no-store');
    const manualKey = ((await enrollment.json()) as { manualKey: string })
      .manualKey;
    const code = totpCode(
      decodeBase32(manualKey),
      Math.floor(now.getTime() / 30_000),
    );
    const confirmed = await post('/mfa/enroll/confirm', { code }, cookie);
    expect(confirmed.status).toBe(200);
    const recoveryCodes = ((await confirmed.json()) as { codes: string[] })
      .codes;
    expect(recoveryCodes).toHaveLength(10);

    const challenge = await post('/sign-in', { email: input.email, password });
    expect(challenge.status).toBe(200);
    const challengeBody = (await challenge.json()) as {
      status: string;
      challengeToken: string;
    };
    expect(challengeBody.status).toBe('mfa_required');
    const completed = await post('/mfa/challenge', {
      challengeToken: challengeBody.challengeToken,
      code,
      method: 'totp',
    });
    expect(completed.status).toBe(401);
    const nextChallenge = await post('/sign-in', {
      email: input.email,
      password,
    });
    const nextChallengeBody = (await nextChallenge.json()) as {
      challengeToken: string;
    };
    const recovery = await post('/mfa/challenge', {
      challengeToken: nextChallengeBody.challengeToken,
      code: recoveryCodes[0],
      method: 'recovery',
    });
    expect(recovery.status).toBe(200);
    const secondCookie = authCookie(recovery);

    const stepUp = await post(
      '/step-up',
      { method: 'password', password },
      cookie,
    );
    expect(stepUp.status).toBe(200);
    const sessions = await fetch(`${baseUrl}/sessions`, {
      headers: { Cookie: cookie },
    });
    expect(sessions.status).toBe(200);
    expect(
      ((await sessions.json()) as { sessions: unknown[] }).sessions,
    ).toHaveLength(2);
    const signedOut = await post('/sign-out', {}, cookie);
    expect(signedOut.status).toBe(200);
    expect(
      (await fetch(`${baseUrl}/sessions`, { headers: { Cookie: cookie } }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/sessions`, {
          headers: { Cookie: secondCookie },
        })
      ).status,
    ).toBe(200);
    const native = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Athlentry-Request': '1',
      },
      body: JSON.stringify({ email: input.email, password, client: 'ios' }),
    });
    expect(native.status).toBe(200);
    expect(native.headers.get('set-cookie')).toBeNull();
    const nativeChallenge = (await native.json()) as {
      status: string;
      challengeToken: string;
    };
    expect(nativeChallenge.status).toBe('mfa_required');
    const nativeMfa = await fetch(`${baseUrl}/token/mfa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Athlentry-Request': '1',
      },
      body: JSON.stringify({
        challengeToken: nativeChallenge.challengeToken,
        code: recoveryCodes[1],
        method: 'recovery',
        client: 'ios',
      }),
    });
    expect(nativeMfa.status).toBe(200);
    const bearer = ((await nativeMfa.json()) as { token: string }).token;
    expect(bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bearerHeaders = {
      Authorization: `Bearer ${bearer}`,
      'X-Athlentry-Request': '1',
    };
    expect(
      (await fetch(`${baseUrl}/sessions`, { headers: bearerHeaders })).status,
    ).toBe(200);

    const wrongOrigin = await fetch(`${baseUrl}/devices`, {
      method: 'POST',
      headers: {
        ...bearerHeaders,
        Origin: 'https://attacker.invalid',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ platform: 'apns', token: 'a'.repeat(64) }),
    });
    expect(wrongOrigin.status).toBe(403);
    const deviceRequest = () =>
      fetch(`${baseUrl}/devices`, {
        method: 'POST',
        headers: { ...bearerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'apns', token: 'a'.repeat(64) }),
      });
    const device = await deviceRequest();
    expect(device.status).toBe(200);
    const deviceId = ((await device.json()) as { id: string }).id;
    const repeated = await deviceRequest();
    expect(((await repeated.json()) as { id: string }).id).toBe(deviceId);
    const mismatched = await fetch(`${baseUrl}/devices`, {
      method: 'POST',
      headers: { ...bearerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'webpush',
        subscription: {
          endpoint: 'https://push.example.invalid/123',
          keys: { p256dh: 'key', auth: 'secret' },
        },
      }),
    });
    expect(mismatched.status).toBe(403);
    const listed = await fetch(`${baseUrl}/devices`, {
      headers: bearerHeaders,
    });
    expect(
      ((await listed.json()) as { devices: unknown[] }).devices,
    ).toHaveLength(1);
    const revoked = await fetch(`${baseUrl}/devices/${deviceId}`, {
      method: 'DELETE',
      headers: bearerHeaders,
    });
    expect(revoked.status).toBe(200);
    const afterRevoke = await fetch(`${baseUrl}/devices`, {
      headers: bearerHeaders,
    });
    expect(
      ((await afterRevoke.json()) as { devices: unknown[] }).devices,
    ).toHaveLength(0);
    const webPush = await post(
      '/devices',
      {
        platform: 'webpush',
        subscription: {
          endpoint: 'https://push.example.invalid/123',
          keys: { p256dh: 'key', auth: 'secret' },
        },
      },
      secondCookie,
    );
    expect(webPush.status).toBe(200);
    const webPushId = ((await webPush.json()) as { id: string }).id;
    const webPushList = await fetch(`${baseUrl}/devices`, {
      headers: { Cookie: secondCookie },
    });
    expect(
      ((await webPushList.json()) as { devices: { id: string }[] }).devices,
    ).toEqual([expect.objectContaining({ id: webPushId })]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const requested = await post('/magic/request', {
        email: 'unknown@example.invalid',
      });
      expect(requested.status).toBe(202);
      expect(await requested.json()).toEqual({
        message:
          'If this address has an account, check your email for a sign-in link.',
      });
    }
    const limited = await post('/magic/request', {
      email: 'unknown@example.invalid',
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
    expect(await limited.json()).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
  });
});
