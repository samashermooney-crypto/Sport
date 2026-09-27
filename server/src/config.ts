import { createECDH, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import { getDatabase } from './db/kysely';
import { integrationConfigs, serverModules } from './generated/registry';
import { AlwaysPassCaptcha } from './integrations/captcha/provider';
import { createMailpitEmailSender } from './integrations/email/sender';
import { parseEncryptionKeys } from './lib/crypto';
import type { EncryptionKeys } from './lib/crypto';
import { createAuthRateLimits } from './modules/auth/rate-limits';
import type { AuthDependencies } from './modules/auth/routes';

const localKeyFile = resolve('data/dev-encryption-key.json');
const localVapidFile = resolve('data/dev-vapid.json');

export async function localVapidPublicKey(
  filePath = localVapidFile,
): Promise<string> {
  try {
    const saved: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    return z
      .strictObject({ publicKey: z.string(), privateKey: z.string() })
      .parse(saved).publicKey;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  await mkdir(resolve(filePath, '..'), { recursive: true });
  const key = createECDH('prime256v1');
  key.generateKeys();
  const publicKey = key
    .getPublicKey(undefined, 'uncompressed')
    .toString('base64url');
  const value = JSON.stringify({
    publicKey,
    privateKey: key.getPrivateKey().toString('base64url'),
  });
  try {
    await writeFile(filePath, value, { flag: 'wx', mode: 0o600 });
    return publicKey;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
    return z
      .strictObject({ publicKey: z.string(), privateKey: z.string() })
      .parse(JSON.parse(await readFile(filePath, 'utf8'))).publicKey;
  }
}

async function localEncryptionKeys(): Promise<EncryptionKeys> {
  try {
    const saved = await readFile(localKeyFile, 'utf8');
    return parseEncryptionKeys(saved, 'local-1');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  await mkdir(resolve('data'), { recursive: true });
  const value = JSON.stringify({
    'local-1': randomBytes(32).toString('base64'),
  });
  try {
    await writeFile(localKeyFile, value, { flag: 'wx', mode: 0o600 });
    return parseEncryptionKeys(value, 'local-1');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
    return parseEncryptionKeys(await readFile(localKeyFile, 'utf8'), 'local-1');
  }
}

const runtimeSchema = z.strictObject({
  nodeEnv: z.enum(['development', 'test', 'production']),
  appUrl: z.url(),
  deliveryMode: z.enum(['preview', 'live']),
  legalApproved: z.boolean(),
  sessionSecret: z.string().optional(),
  stripeKey: z.string().optional(),
});

export async function createLocalAuthDependencies(): Promise<AuthDependencies> {
  const localIntegrationConfig: Record<string, unknown> = {
    'background-check': { mode: 'manual' },
    email: {
      mode: 'preview',
      host: '127.0.0.1',
      port: process.env.ATHLENTRY_MAILPIT_SMTP_PORT ?? '1025',
    },
    geocoder: { mode: 'none' },
    push: { mode: 'preview' },
    sms: { mode: 'preview' },
    storage: { mode: 'local', directory: 'data/uploads' },
  };
  for (const integration of integrationConfigs) {
    integration.schema.parse(localIntegrationConfig[integration.name]);
  }
  for (const module of serverModules) {
    module.configSchema?.parse(process.env);
  }
  const runtime = runtimeSchema.parse({
    nodeEnv: process.env.NODE_ENV ?? 'development',
    appUrl: process.env.APP_URL ?? 'http://127.0.0.1:5173',
    deliveryMode: process.env.DELIVERY_MODE ?? 'preview',
    legalApproved: process.env.LEGAL_DOCS_APPROVED === 'true',
    sessionSecret: process.env.SESSION_SECRET,
    stripeKey: process.env.STRIPE_SECRET_KEY,
  });
  if (runtime.stripeKey?.startsWith('sk_live_')) {
    throw new Error('Live Stripe keys are forbidden in this environment');
  }
  if (runtime.nodeEnv === 'production') {
    if (!runtime.legalApproved || (runtime.sessionSecret?.length ?? 0) < 32) {
      throw new Error(
        'Production requires approved legal documents and a strong session secret',
      );
    }
    throw new Error('Production auth adapters are not configured');
  }
  if (runtime.deliveryMode !== 'preview') {
    throw new Error('Local development must use preview delivery');
  }
  const encryption =
    process.env.DATA_ENCRYPTION_KEYS && process.env.DATA_ENCRYPTION_ACTIVE_KID
      ? parseEncryptionKeys(
          process.env.DATA_ENCRYPTION_KEYS,
          process.env.DATA_ENCRYPTION_ACTIVE_KID,
        )
      : await localEncryptionKeys();
  return {
    database: getDatabase(),
    rateLimits: createAuthRateLimits(
      process.env.DATABASE_URL ??
        'postgres://athlentry_app@127.0.0.1:5432/athlentry_dev',
    ),
    email: createMailpitEmailSender(),
    captcha: new AlwaysPassCaptcha(),
    captchaWidget: { mode: 'preview' },
    pushPublicKey: await localVapidPublicKey(),
    encryption,
    appUrl: runtime.appUrl,
    clock: () => new Date(),
  };
}
