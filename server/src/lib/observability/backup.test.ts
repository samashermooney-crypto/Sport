import { createDecipheriv, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  backupKey,
  createEncryptedBackup,
  parsePgConnection,
  restoreEncryptedBackup,
  signBackupObjectRequest,
  uploadEncryptedBackup,
} from './backup';

const previousPath = process.env.PATH;
const previousKey = process.env.BACKUP_ENCRYPTION_KEY;
let scratchDirectory: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
  else process.env.BACKUP_ENCRYPTION_KEY = previousKey;
  if (scratchDirectory) {
    await rm(scratchDirectory, { recursive: true, force: true });
    scratchDirectory = undefined;
  }
});

describe('encrypted logical backup helpers', () => {
  it('validates PostgreSQL URLs and a distinct 256-bit backup key', () => {
    expect(
      parsePgConnection(
        'postgres://athlentry_admin@127.0.0.1:6832/athlentry_dev',
      ),
    ).toMatchObject({
      host: '127.0.0.1',
      port: 6832,
      database: 'athlentry_dev',
    });
    expect(() => parsePgConnection('https://example.test/db')).toThrow();
    expect(() => backupKey('not-a-base64-key')).toThrow();
  });

  it('signs object uploads without exposing the secret key and rejects partial config', async () => {
    const signed = signBackupObjectRequest({
      method: 'PUT',
      uri: '/nightly/dump.athlentry-backup',
      host: 'backup.example.test',
      region: 'us-east-1',
      accessKeyId: 'TESTACCESS',
      secretAccessKey: 'private-test-secret',
      contentLength: 42,
      payloadHash: 'a'.repeat(64),
      now: new Date('2026-09-27T15:00:00.000Z'),
    });
    expect(signed.amzDate).toBe('20260927T150000Z');
    expect(signed.authorization).toContain(
      'Credential=TESTACCESS/20260927/us-east-1/s3/aws4_request',
    );
    expect(signed.authorization).not.toContain('private-test-secret');
    await expect(
      uploadEncryptedBackup('/not-used.athlentry-backup', {
        BACKUP_S3_ENDPOINT: 'https://storage.example.test',
      }),
    ).rejects.toThrow('Backup object storage configuration is incomplete');
    await expect(
      uploadEncryptedBackup('/not-used.athlentry-backup', {}),
    ).resolves.toBeNull();
  });

  it('encrypts a streamed dump and authenticates it before restore', async () => {
    scratchDirectory = await mkdtemp(join(tmpdir(), 'athlentry-backup-test-'));
    const bin = join(scratchDirectory, 'bin');
    await mkdir(bin);
    const dumpTool = join(bin, 'pg_dump');
    const restoreTool = join(bin, 'psql');
    const capture = join(scratchDirectory, 'restored.sql');
    const escapedCapture = capture.replaceAll("'", "'\\''");
    await writeFile(
      dumpTool,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nprintf "CREATE TABLE backup_probe (id integer);\\nINSERT INTO backup_probe VALUES (42);\\n"\n',
      { mode: 0o700 },
    );
    await writeFile(
      restoreTool,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\ncat > '${escapedCapture}'\n`,
      { mode: 0o700 },
    );
    await chmod(dumpTool, 0o700);
    await chmod(restoreTool, 0o700);
    vi.stubEnv('PATH', `${bin}:${previousPath ?? ''}`);
    const key = randomBytes(32);
    vi.stubEnv('BACKUP_ENCRYPTION_KEY', key.toString('base64'));

    const backupPath = await createEncryptedBackup(
      'postgres://athlentry_admin@127.0.0.1:6832/athlentry_dev',
      scratchDirectory,
    );
    const file = await readFile(backupPath);
    expect(file.includes(Buffer.from('CREATE TABLE backup_probe'))).toBe(false);
    const magic = Buffer.from('ATHLENTRY-BACKUP-V1\n', 'ascii');
    const nonce = file.subarray(magic.length, magic.length + 12);
    const tag = file.subarray(file.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([
      decipher.update(file.subarray(magic.length + 12, file.length - 16)),
      decipher.final(),
    ]);
    expect(gunzipSync(compressed).toString()).toContain('VALUES (42)');

    await restoreEncryptedBackup(
      backupPath,
      'postgres://athlentry_admin@127.0.0.1:6832/athlentry_ops_restore_probe',
    );
    expect(await readFile(capture, 'utf8')).toContain('VALUES (42)');
    await expect(
      restoreEncryptedBackup(
        backupPath,
        'postgres://athlentry_admin@127.0.0.1:6832/athlentry_dev',
      ),
    ).rejects.toThrow(
      'Encrypted backups may only be restored into a scratch database',
    );

    const tampered = join(scratchDirectory, 'tampered.athlentry-backup');
    const changed = Buffer.from(file);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    await writeFile(tampered, changed);
    await expect(
      restoreEncryptedBackup(
        tampered,
        'postgres://athlentry_admin@127.0.0.1:6832/athlentry_ops_restore_probe',
      ),
    ).rejects.toThrow('Encrypted PostgreSQL restore failed');
  });
});
