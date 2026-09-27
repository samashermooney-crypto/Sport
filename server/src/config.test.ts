import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { localVapidPublicKey } from './config';

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
