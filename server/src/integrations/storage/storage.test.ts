import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createStorageAdapter, storageConfigFromEnvironment } from './config';
import {
  LocalDiskStorage,
  MemoryStorage,
  S3Storage,
  createStorageKey,
} from './storage';

describe('storage configuration', () => {
  it('uses local storage in development and supports an explicit directory', () => {
    const config = storageConfigFromEnvironment({
      NODE_ENV: 'development',
      ATHLENTRY_STORAGE_DIRECTORY: '/tmp/athlentry-uploads',
    });
    expect(config).toEqual({
      mode: 'local',
      directory: '/tmp/athlentry-uploads',
    });
    expect(createStorageAdapter(config)).toBeInstanceOf(LocalDiskStorage);
  });

  it('requires complete private S3 configuration in production', () => {
    expect(() =>
      storageConfigFromEnvironment({ NODE_ENV: 'production' }),
    ).toThrow('Production requires private S3-compatible storage');
    expect(() =>
      storageConfigFromEnvironment({
        S3_ENDPOINT: 'https://objects.example.test',
      }),
    ).toThrow('S3 storage configuration is incomplete');
  });

  it('creates the S3 adapter from the configured private endpoint', () => {
    const config = storageConfigFromEnvironment({
      NODE_ENV: 'production',
      S3_ENDPOINT: 'https://objects.example.test',
      S3_REGION: 'auto',
      S3_BUCKET: 'private-athlentry-test',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
    });
    expect(config.mode).toBe('s3');
    expect(createStorageAdapter(config)).toBeInstanceOf(S3Storage);
  });

  it('keeps memory storage available for isolated tests', () => {
    expect(createStorageAdapter({ mode: 'memory' })).toBeInstanceOf(
      MemoryStorage,
    );
  });
});

describe('storage adapters', () => {
  it('roundtrips bytes in memory storage', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      'x/a',
      new Uint8Array([1, 2]),
      'application/octet-stream',
    );
    expect((await storage.get('x/a'))?.bytes).toEqual(new Uint8Array([1, 2]));
  });
  it('roundtrips bytes on local disk and rejects path traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'athlentry-files-'));
    try {
      const storage = new LocalDiskStorage(dir);
      await storage.put('org/a.txt', new Uint8Array([3]), 'text/plain');
      expect(
        Buffer.from((await storage.get('org/a.txt'))?.bytes ?? []),
      ).toEqual(Buffer.from([3]));
      await expect(
        storage.put('../outside', new Uint8Array([1]), 'text/plain'),
      ).rejects.toThrow('Invalid storage key');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('names objects under the organization and purpose', () => {
    expect(createStorageKey('org-id', 'document', 'pdf')).toMatch(
      /^org-id\/document\/.+\.pdf$/,
    );
  });
});

describe('S3 compatible storage signing', () => {
  it('signs uploads for the declared exact size, MIME type, and short expiry', async () => {
    const { S3CompatibleObjectClient } = await import('./storage');
    const client = new S3CompatibleObjectClient({
      endpoint: 'https://objects.example.test',
      bucket: 'private-athlentry',
      region: 'auto',
      credentials: {
        accessKeyId: 'fixture-access',
        secretAccessKey: 'fixture-secret',
      },
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const url = new URL(
      await client.presignPut(
        'org/document/test.pdf',
        'application/pdf',
        1234,
        900,
      ),
    );
    expect(url.hostname).toBe('objects.example.test');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host',
    );
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  });
  it('rejects unsafe paths and excessive link durations', async () => {
    const { S3CompatibleObjectClient } = await import('./storage');
    const client = new S3CompatibleObjectClient({
      endpoint: 'https://objects.example.test',
      bucket: 'private',
      region: 'auto',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    });
    expect(() => client.presignPut('../escape', 'text/plain', 10, 900)).toThrow(
      'Invalid storage key',
    );
    expect(() => client.presignGet('safe/key', 604801)).toThrow('expiry');
  });
});
