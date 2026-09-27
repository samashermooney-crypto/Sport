import { createECDH } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateEncryptionKeyFile } from '../../../scripts/keys-generate';
import { generateVapidKeyFile } from '../../../scripts/keys-vapid';

let scratchDirectory: string | undefined;

afterEach(async () => {
  if (scratchDirectory) {
    await rm(scratchDirectory, { recursive: true, force: true });
    scratchDirectory = undefined;
  }
});

describe('operator key generation', () => {
  it('writes a protected 256-bit data key and refuses to overwrite it', async () => {
    scratchDirectory = await mkdtemp(join(tmpdir(), 'athlentry-keys-test-'));
    const path = join(scratchDirectory, 'data-keys.json');

    await generateEncryptionKeyFile(path);

    const keys = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      string
    >;
    const values = Object.values(keys);
    expect(values).toHaveLength(1);
    expect(Buffer.from(values[0] ?? '', 'base64')).toHaveLength(32);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(scratchDirectory)).mode & 0o777).toBe(0o700);
    await expect(generateEncryptionKeyFile(path)).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('writes a protected P-256 VAPID pair with matching public-key encoding', async () => {
    scratchDirectory = await mkdtemp(join(tmpdir(), 'athlentry-vapid-test-'));
    const path = join(scratchDirectory, 'vapid-keys.json');

    await generateVapidKeyFile(path);

    const pair = JSON.parse(await readFile(path, 'utf8')) as {
      publicKey: string;
      privateKey: string;
    };
    const publicKey = Buffer.from(pair.publicKey, 'base64url');
    const privateKey = Buffer.from(pair.privateKey, 'base64url');
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateKey);
    expect(ecdh.getPublicKey(undefined, 'uncompressed')).toEqual(publicKey);
    expect(publicKey).toHaveLength(65);
    expect(publicKey[0]).toBe(4);
    expect(privateKey).toHaveLength(32);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(scratchDirectory)).mode & 0o777).toBe(0o700);
    await expect(generateVapidKeyFile(path)).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });
});
