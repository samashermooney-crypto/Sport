import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createLocalAuthDependencies,
  localVapidPublicKey,
  productionAuthConfig,
} from './config';
import { TurnstileCaptcha } from './integrations/captcha/provider';

describe('local VAPID key storage', () => {
  it('creates a fresh key once and exposes only its public half', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athlentry-vapid-'));
    const file = join(directory, 'nested', 'dev-vapid.json');
    const publicKey = await localVapidPublicKey(file);
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      publicKey: string;
      privateKey: string;
    };
    expect(saved.publicKey).toBe(publicKey);
    expect(saved.privateKey).toBeTruthy();
    expect(publicKey).not.toBe(saved.privateKey);
    expect(await localVapidPublicKey(file)).toBe(publicKey);
    expect((await stat(file)).mode & 0o077).toBe(0);
  });
});

describe('production auth configuration', () => {
  it('rejects missing credentials without revealing secret values', () => {
    expect(() =>
      productionAuthConfig({
        APP_URL: 'https://athlentry.example',
        TURNSTILE_SECRET_KEY: 'private-token',
      }),
    ).toThrow('Production auth configuration is incomplete');
  });

  it('starts with the server-side Turnstile adapter and live email adapter', async () => {
    const original = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'production',
      APP_URL: 'https://athlentry.example',
      DELIVERY_MODE: 'live',
      LEGAL_DOCS_APPROVED: 'true',
      SESSION_SECRET: 'a'.repeat(32),
      DATABASE_URL: process.env.TEST_DATABASE_APP_URL,
      DATA_ENCRYPTION_KEYS: JSON.stringify({
        'test-1': Buffer.alloc(32, 7).toString('base64'),
      }),
      DATA_ENCRYPTION_ACTIVE_KID: 'test-1',
      RESEND_API_KEY: 'test-resend-key',
      MAIL_FROM: 'noreply@athlentry.example',
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET_KEY: 'test-secret-key',
      VAPID_PUBLIC_KEY: 'test-public-key',
    });
    try {
      const dependencies = await createLocalAuthDependencies();
      expect(dependencies.captcha).toBeInstanceOf(TurnstileCaptcha);
      expect(dependencies.captchaWidget).toEqual({
        mode: 'turnstile',
        siteKey: 'test-site-key',
      });
      await dependencies.rateLimits.close();
      await dependencies.database.destroy();
    } finally {
      process.env = original;
    }
  });
});
