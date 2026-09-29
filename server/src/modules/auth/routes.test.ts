import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
    captchaWidget: { mode: 'preview' },
    pushPublicKey: 'test-public-key',
    appUrl: origin,
    clock: () => now,
  }).listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/auth`;
});

beforeEach(async () => {
  await database.deleteFrom('rate_limit_points').execute();
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
    const captchaConfig = await fetch(`${baseUrl}/captcha-config`);
    expect(captchaConfig.status).toBe(200);
    expect(await captchaConfig.json()).toEqual({ mode: 'preview' });
    const pushConfig = await fetch(`${baseUrl}/push-config`);
    expect(await pushConfig.json()).toEqual({ publicKey: 'test-public-key' });
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
    const me = await fetch(`${baseUrl}/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      email: input.email,
      mfaEnabled: false,
      client: 'web',
      locale: 'en',
    });
    const rejectedLocale = await fetch(`${baseUrl}/locale`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        'X-Athlentry-Request': '1',
        'Content-Type': 'application/json',
        Origin: 'https://elsewhere.invalid',
      },
      body: JSON.stringify({ locale: 'es' }),
    });
    expect(rejectedLocale.status).toBe(403);
    const savedLocale = await fetch(`${baseUrl}/locale`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        'X-Athlentry-Request': '1',
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({ locale: 'es' }),
    });
    expect(savedLocale.status).toBe(200);
    expect(await savedLocale.json()).toEqual({ locale: 'es' });
    const updatedMe = await fetch(`${baseUrl}/me`, {
      headers: { Cookie: cookie },
    });
    expect(await updatedMe.json()).toMatchObject({ locale: 'es' });
    expect(
      (
        await fetch(`${baseUrl}/locale`, {
          method: 'PATCH',
          headers: {
            Cookie: cookie,
            'X-Athlentry-Request': '1',
            'Content-Type': 'application/json',
            Origin: origin,
          },
          body: JSON.stringify({ locale: 'en' }),
        })
      ).status,
    ).toBe(200);

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
    expect(await stepUp.json()).toEqual({
      client: 'web',
      status: 'elevated',
    });
    const steppedCookie = authCookie(stepUp);
    expect(steppedCookie).not.toBe(cookie);
    expect(
      (await fetch(`${baseUrl}/me`, { headers: { Cookie: cookie } })).status,
    ).toBe(401);
    const sessions = await fetch(`${baseUrl}/sessions`, {
      headers: { Cookie: steppedCookie },
    });
    expect(sessions.status).toBe(200);
    expect(
      ((await sessions.json()) as { sessions: unknown[] }).sessions,
    ).toHaveLength(2);
    const signedOut = await post('/sign-out', {}, steppedCookie);
    expect(signedOut.status).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/sessions`, {
          headers: { Cookie: steppedCookie },
        })
      ).status,
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
    const nativeStepUp = await fetch(`${baseUrl}/step-up`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'X-Athlentry-Request': '1',
        Origin: origin,
      },
      body: JSON.stringify({ method: 'password', password }),
    });
    expect(nativeStepUp.status).toBe(200);
    const nativeStepUpBody = (await nativeStepUp.json()) as {
      client: string;
      status: string;
      token: string;
      absoluteExpiresAt: string;
    };
    expect(nativeStepUpBody).toMatchObject({
      client: 'ios',
      status: 'elevated',
    });
    expect(nativeStepUp.headers.get('set-cookie')).toBeNull();
    expect(nativeStepUp.headers.get('cache-control')).toBe('no-store');
    expect(nativeStepUpBody.token).not.toBe(bearer);
    expect(
      (
        await fetch(`${baseUrl}/sessions`, {
          headers: { Authorization: `Bearer ${bearer}` },
        })
      ).status,
    ).toBe(401);
    const replacementBearer = nativeStepUpBody.token;
    const bearerHeaders = {
      Authorization: `Bearer ${replacementBearer}`,
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

    const androidChallengeResponse = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Athlentry-Request': '1',
      },
      body: JSON.stringify({
        email: input.email,
        password,
        client: 'android',
      }),
    });
    expect(androidChallengeResponse.status).toBe(200);
    const androidChallenge = (await androidChallengeResponse.json()) as {
      status: string;
      challengeToken: string;
    };
    expect(androidChallenge.status).toBe('mfa_required');
    const androidMfa = await fetch(`${baseUrl}/token/mfa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Athlentry-Request': '1',
      },
      body: JSON.stringify({
        challengeToken: androidChallenge.challengeToken,
        code: recoveryCodes[2],
        method: 'recovery',
        client: 'android',
      }),
    });
    expect(androidMfa.status).toBe(200);
    const androidBearer = ((await androidMfa.json()) as { token: string })
      .token;
    const fcm = await fetch(`${baseUrl}/devices`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${androidBearer}`,
        'Content-Type': 'application/json',
        'X-Athlentry-Request': '1',
      },
      body: JSON.stringify({ platform: 'fcm', token: 'f'.repeat(64) }),
    });
    expect(fcm.status).toBe(200);
    const fcmDevice = (await fcm.json()) as { id: string; platform: string };
    expect(fcmDevice.platform).toBe('fcm');
    expect(fcmDevice).not.toHaveProperty('token');
    const androidDevices = await fetch(`${baseUrl}/devices`, {
      headers: { Authorization: `Bearer ${androidBearer}` },
    });
    expect(
      ((await androidDevices.json()) as { devices: { id: string }[] }).devices,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fcmDevice.id, platform: 'fcm' }),
      ]),
    );

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

  it('routes recovery, credential changes, session revocation, and deletion requests', async () => {
    const emailStart = email.messages.length;
    const accountEmail = `recovery-${randomBytes(6).toString('hex')}@example.invalid`;
    const input = {
      email: accountEmail,
      password,
      firstName: 'Recovery',
      lastName: 'Owner',
      dateOfBirth: '1990-01-01',
      termsAccepted: true,
      privacyAccepted: true,
      captchaToken: 'test-token',
    };
    expect((await post('/sign-up', input)).status).toBe(202);
    expect(
      (
        await post('/verify-email', {
          token: emailToken(emailStart, 'verify'),
        })
      ).status,
    ).toBe(200);

    expect((await post('/magic/request', { email: accountEmail })).status).toBe(
      202,
    );
    const magicToken = emailToken(emailStart + 1, 'magic');
    const magic = await post('/magic/redeem', { token: magicToken });
    expect(magic.status).toBe(200);
    const magicCookie = authCookie(magic);
    expect(
      (await fetch(`${baseUrl}/me`, { headers: { Cookie: magicCookie } }))
        .status,
    ).toBe(200);

    expect(
      (await post('/password/reset/request', { email: accountEmail })).status,
    ).toBe(202);
    const resetEmailIndex = email.messages.findIndex(
      (message, index) =>
        index >= emailStart && message.text.includes('/reset/'),
    );
    const nextPassword = 'Tall cedars and quiet rivers 82';
    expect(
      (
        await post('/password/reset/confirm', {
          token: emailToken(resetEmailIndex, 'reset'),
          newPassword: nextPassword,
        })
      ).status,
    ).toBe(200);

    const signedIn = await post('/sign-in', {
      email: accountEmail,
      password: nextPassword,
    });
    expect(signedIn.status).toBe(200);
    const signedInCookie = authCookie(signedIn);
    const changedPassword = 'Red maple leaves and clear skies 83';
    expect(
      (
        await post(
          '/password/change',
          { currentPassword: nextPassword, newPassword: changedPassword },
          signedInCookie,
        )
      ).status,
    ).toBe(200);
    const elevated = await post(
      '/step-up',
      { method: 'password', password: changedPassword },
      signedInCookie,
    );
    expect(elevated.status).toBe(200);
    const elevatedCookie = authCookie(elevated);

    const nextEmail = `updated-${randomBytes(6).toString('hex')}@example.invalid`;
    expect(
      (
        await post(
          '/email/change/request',
          { email: nextEmail },
          elevatedCookie,
        )
      ).status,
    ).toBe(202);
    const emailChangeIndex = email.messages.findIndex(
      (message, index) =>
        index >= emailStart && message.text.includes('/verify-email-change/'),
    );
    const emailChanged = await post('/email/change/confirm', {
      token: emailToken(emailChangeIndex, 'verify-email-change'),
    });
    expect(emailChanged.status).toBe(200);
    expect(emailChanged.headers.get('set-cookie')).toContain(
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );

    const restoredSession = await post('/sign-in', {
      email: nextEmail,
      password: changedPassword,
    });
    expect(restoredSession.status).toBe(200);
    const restoredCookie = authCookie(restoredSession);
    const restoredStepUp = await post(
      '/step-up',
      { method: 'password', password: changedPassword },
      restoredCookie,
    );
    expect(restoredStepUp.status).toBe(200);
    const deletionCookie = authCookie(restoredStepUp);

    const deletion = await post(
      '/account-deletion',
      { reason: 'This account is no longer needed.' },
      deletionCookie,
    );
    expect(deletion.status).toBe(202);
    const deletionBody = (await deletion.json()) as { requestId: string };
    expect(deletionBody.requestId).toEqual(expect.any(String));

    const unknownDevice = await fetch(
      `${baseUrl}/devices/00000000-0000-4000-8000-000000000001`,
      {
        method: 'DELETE',
        headers: {
          Cookie: deletionCookie,
          Origin: origin,
          'X-Athlentry-Request': '1',
        },
      },
    );
    expect(unknownDevice.status).toBe(404);

    const sessions = await fetch(`${baseUrl}/sessions`, {
      headers: { Cookie: deletionCookie },
    });
    const session = (
      (await sessions.json()) as {
        sessions: Array<{ id: string }>;
      }
    ).sessions[0];
    const sessionId = session?.id;
    if (!sessionId) throw new Error('Expected an active auth session');
    let stepUpWasLimited = false;
    for (let attempt = 0; attempt < 9 && !stepUpWasLimited; attempt += 1) {
      const rejectedStepUp = await post(
        '/step-up',
        { method: 'password', password: 'wrong password' },
        deletionCookie,
      );
      if (rejectedStepUp.status === 429) stepUpWasLimited = true;
      else expect(rejectedStepUp.status).toBe(401);
    }
    expect(stepUpWasLimited).toBe(true);
    const revoked = await fetch(`${baseUrl}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: {
        Cookie: deletionCookie,
        Origin: origin,
        'X-Athlentry-Request': '1',
      },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get('set-cookie')).toContain(
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );

    expect(
      (
        await post('/sign-in', {
          email: accountEmail,
          password: 'wrong password',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post('/sign-up', {
          ...input,
          email: `underage-${randomBytes(6).toString('hex')}@example.invalid`,
          dateOfBirth: '2015-01-01',
        })
      ).status,
    ).toBe(422);
    expect(magicCookie).not.toBe('');
  });
});
