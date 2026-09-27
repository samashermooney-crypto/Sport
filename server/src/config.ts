import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import { getDatabase } from './db/kysely';
import { AlwaysPassCaptcha } from './integrations/captcha/provider';
import { createMailpitEmailSender } from './integrations/email/sender';
import { parseEncryptionKeys } from './lib/crypto';
import type { EncryptionKeys } from './lib/crypto';
import type { AuthDependencies } from './modules/auth/routes';

const localKeyFile = resolve('data/dev-encryption-key.json');

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
    email: createMailpitEmailSender(),
    captcha: new AlwaysPassCaptcha(),
    encryption,
    appUrl: runtime.appUrl,
    clock: () => new Date(),
  };
}
