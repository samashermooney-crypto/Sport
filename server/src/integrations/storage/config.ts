import { z } from 'zod';

import type { IntegrationConfig } from '../../lib/module-contract';

import {
  LocalDiskStorage,
  MemoryStorage,
  S3CompatibleObjectClient,
  S3Storage,
} from './storage';
import type { Storage } from './storage';

export const storageConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('memory') }),
  z.strictObject({ mode: z.literal('local'), directory: z.string().min(1) }),
  z.strictObject({
    mode: z.literal('s3'),
    endpoint: z.url(),
    bucket: z.string().min(1),
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  }),
]);
export type StorageConfig = z.infer<typeof storageConfigSchema>;

export function storageConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): StorageConfig {
  const s3Values = {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
  const configured = Object.entries(s3Values).filter(([, value]) =>
    Boolean(value?.trim()),
  );
  if (
    configured.length > 0 &&
    configured.length !== Object.keys(s3Values).length
  ) {
    const missing = Object.entries(s3Values)
      .filter(([, value]) => !value?.trim())
      .map(
        ([key]) =>
          `S3_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`,
      );
    throw new Error(
      `S3 storage configuration is incomplete: ${missing.join(', ')}`,
    );
  }
  if (configured.length === Object.keys(s3Values).length) {
    return storageConfigSchema.parse({ mode: 's3', ...s3Values });
  }
  if (env.NODE_ENV === 'production')
    throw new Error('Production requires private S3-compatible storage');
  return storageConfigSchema.parse({
    mode: 'local',
    directory: env.ATHLENTRY_STORAGE_DIRECTORY?.trim() || 'data/uploads',
  });
}

export function createStorageAdapter(config: StorageConfig): Storage {
  const parsed = storageConfigSchema.parse(config);
  if (parsed.mode === 'memory') return new MemoryStorage();
  if (parsed.mode === 'local') return new LocalDiskStorage(parsed.directory);
  return new S3Storage(
    new S3CompatibleObjectClient({
      endpoint: parsed.endpoint,
      bucket: parsed.bucket,
      region: parsed.region,
      credentials: {
        accessKeyId: parsed.accessKeyId,
        secretAccessKey: parsed.secretAccessKey,
      },
    }),
  );
}

export function createStorageAdapterFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Storage {
  return createStorageAdapter(storageConfigFromEnvironment(env));
}

export const integrationConfig = {
  name: 'storage',
  schema: storageConfigSchema,
} satisfies IntegrationConfig;
