import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, chmod, mkdir, open, rm, stat } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';

const MAGIC = Buffer.from('ATHLENTRY-BACKUP-V1\n', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type PgConnection = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslmode?: string;
};

export function parsePgConnection(connectionString: string): PgConnection {
  const url = new URL(connectionString);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('PostgreSQL connection URL is invalid');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const port = url.port ? Number(url.port) : 5432;
  if (!database || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('PostgreSQL connection URL is incomplete');
  const sslmode = url.searchParams.get('sslmode');
  return {
    host: decodeURIComponent(url.hostname),
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ...(sslmode ? { sslmode } : {}),
  };
}

export function backupKey(encoded = process.env.BACKUP_ENCRYPTION_KEY): Buffer {
  if (!encoded) throw new Error('BACKUP_ENCRYPTION_KEY is required');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded)
    throw new Error('BACKUP_ENCRYPTION_KEY must be 32-byte base64');
  return key;
}

function backupFileName(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `athlentry-${timestamp}-${randomBytes(4).toString('hex')}.athlentry-backup`;
}

function pgEnvironment(connectionString: string): NodeJS.ProcessEnv {
  const connection = parsePgConnection(connectionString);
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
    ...(connection.sslmode ? { PGSSLMODE: connection.sslmode } : {}),
  };
}

function spawnPgTool(
  command: 'pg_dump' | 'psql',
  args: string[],
  connectionString: string,
): ChildProcessWithoutNullStreams {
  const env = pgEnvironment(connectionString);
  const hasNativeTools =
    spawnSync(command, ['--version'], {
      stdio: 'ignore',
      env,
    }).status === 0;
  if (hasNativeTools) {
    const child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    if (command === 'psql') child.stdout.resume();
    return child;
  }

  const connection = parsePgConnection(connectionString);
  if (
    !process.env.PGTOOLS_DOCKER_COMPOSE ||
    connection.password.length > 0 ||
    !['localhost', '127.0.0.1', '::1'].includes(connection.host)
  ) {
    throw new Error(
      `${command} is unavailable; install PostgreSQL client tools or use the local Compose fallback`,
    );
  }
  const composeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.DOCKER_HOST
      ? { DOCKER_HOST: process.env.DOCKER_HOST }
      : {}),
    ...(process.env.DOCKER_CONTEXT
      ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT }
      : {}),
    ...(process.env.COMPOSE_PROJECT_NAME
      ? { COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME }
      : {}),
    ...(process.env.PORT_OFFSET
      ? { PORT_OFFSET: process.env.PORT_OFFSET }
      : {}),
  };
  const forwarded = [
    '-e',
    'PGHOST=postgres',
    '-e',
    'PGPORT=5432',
    '-e',
    `PGUSER=${connection.user}`,
    '-e',
    `PGDATABASE=${connection.database}`,
  ];
  if (connection.sslmode) {
    forwarded.push('-e', `PGSSLMODE=${connection.sslmode}`);
  }
  const child = spawn(
    'docker',
    ['compose', 'exec', '-T', ...forwarded, 'postgres', command, ...args],
    { env: composeEnv, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stderr.resume();
  if (command === 'psql') child.stdout.resume();
  return child;
}

type BackupS3Config = {
  endpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function backupS3Config(env: NodeJS.ProcessEnv): BackupS3Config | null {
  const values = [
    env.BACKUP_S3_ENDPOINT,
    env.BACKUP_S3_REGION,
    env.BACKUP_S3_BUCKET,
    env.BACKUP_S3_ACCESS_KEY_ID,
    env.BACKUP_S3_SECRET_ACCESS_KEY,
  ];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value))
    throw new Error('Backup object storage configuration is incomplete');
  const endpoint = new URL(env.BACKUP_S3_ENDPOINT ?? '');
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('BACKUP_S3_ENDPOINT must be a plain HTTPS endpoint');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.BACKUP_S3_BUCKET ?? ''))
    throw new Error('BACKUP_S3_BUCKET is invalid');
  return {
    endpoint,
    region: env.BACKUP_S3_REGION ?? '',
    bucket: env.BACKUP_S3_BUCKET ?? '',
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY ?? '',
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function signBackupObjectRequest(input: {
  method: 'PUT';
  uri: string;
  host: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  contentLength: number;
  payloadHash: string;
  now?: Date;
}): { amzDate: string; authorization: string } {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const canonicalHeaders = [
    `content-length:${String(input.contentLength)}`,
    `host:${input.host}`,
    `x-amz-content-sha256:${input.payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
  ].join('\n');
  const signedHeaders = 'content-length;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    input.method,
    input.uri,
    '',
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, date);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');
  return {
    amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.once('error', rejectHash);
    stream.once('end', resolveHash);
  });
  return hash.digest('hex');
}

/** Upload only ciphertext to the dedicated versioned backup bucket. */
export async function uploadEncryptedBackup(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const config = backupS3Config(env);
  if (!config) return null;
  const fileName = basename(path);
  if (!/^athlentry-[A-Za-z0-9-]+\.athlentry-backup$/.test(fileName))
    throw new Error('Backup object name is invalid');
  const fileInfo = await stat(path);
  const payloadHash = await fileSha256(path);
  const objectKey = `nightly/${fileName}`;
  const prefix = config.endpoint.pathname.replace(/\/$/, '');
  const uri = `${prefix}/${encodePathSegment(config.bucket)}/${objectKey
    .split('/')
    .map(encodePathSegment)
    .join('/')}`;
  const signed = signBackupObjectRequest({
    method: 'PUT',
    uri,
    host: config.endpoint.host,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    contentLength: fileInfo.size,
    payloadHash,
  });
  const target = new URL(uri, config.endpoint.origin);
  await new Promise<void>((resolveUpload, rejectUpload) => {
    const request = httpsRequest(
      target,
      {
        method: 'PUT',
        headers: {
          'content-length': String(fileInfo.size),
          'x-amz-content-sha256': payloadHash,
          'x-amz-date': signed.amzDate,
          authorization: signed.authorization,
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => {
          if (
            response.statusCode &&
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            resolveUpload();
          } else {
            rejectUpload(new Error('Backup object upload failed'));
          }
        });
      },
    );
    request.setTimeout(30_000, () => {
      request.destroy(new Error('Backup object upload timed out'));
    });
    request.once('error', () => {
      rejectUpload(new Error('Backup object upload failed'));
    });
    const source = createReadStream(path);
    source.once('error', () => {
      request.destroy(new Error('Backup object upload failed'));
    });
    source.pipe(request);
  });
  return objectKey;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolveExit(code ?? 1);
    });
  });
}

export async function createEncryptedBackup(
  sourceUrl = process.env.BACKUP_DATABASE_URL,
  backupDirectory = process.env.BACKUP_DIR ?? resolve('data/backups'),
): Promise<string> {
  if (!sourceUrl) throw new Error('BACKUP_DATABASE_URL is required');
  const key = backupKey();
  const directory = resolve(backupDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const outputPath = resolve(directory, backupFileName());
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const child = spawnPgTool(
    'pg_dump',
    ['--format=plain', '--no-owner', '--no-privileges', '--no-password'],
    sourceUrl,
  );
  child.stderr.resume();
  const exit = waitForExit(child);
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  try {
    output.write(MAGIC);
    output.write(nonce);
    await pipeline(child.stdout, createGzip({ level: 9 }), cipher, output);
    const exitCode = await exit;
    if (exitCode !== 0) throw new Error('pg_dump failed');
    await appendFile(outputPath, cipher.getAuthTag(), { mode: 0o600 });
    await chmod(outputPath, 0o600);
    return outputPath;
  } catch {
    child.kill('SIGTERM');
    await exit.catch(() => 1);
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw new Error('Encrypted PostgreSQL backup failed');
  }
}

export async function restoreEncryptedBackup(
  backupPath: string,
  targetUrl: string,
): Promise<void> {
  const target = parsePgConnection(targetUrl);
  if (!target.database.startsWith('athlentry_ops_restore_'))
    throw new Error(
      'Encrypted backups may only be restored into a scratch database',
    );
  const key = backupKey();
  const resolved = resolve(backupPath);
  const info = await stat(resolved);
  const headerLength = MAGIC.length + NONCE_BYTES;
  if (info.size < headerLength + TAG_BYTES)
    throw new Error('Encrypted backup is truncated');
  const file = await open(resolved, 'r');
  let header: Buffer;
  let tag: Buffer;
  try {
    header = Buffer.alloc(headerLength);
    tag = Buffer.alloc(TAG_BYTES);
    await file.read(header, 0, headerLength, 0);
    await file.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
  } finally {
    await file.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error('Encrypted backup format is invalid');
  const nonce = header.subarray(MAGIC.length);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const child = spawnPgTool(
    'psql',
    ['--no-psqlrc', '--set=ON_ERROR_STOP=1'],
    targetUrl,
  );
  child.stderr.resume();
  child.stdout.resume();
  const exit = waitForExit(child);
  const ciphertextStart = headerLength;
  const ciphertextEnd = info.size - TAG_BYTES - 1;
  const ciphertext = createReadStream(resolved, {
    start: ciphertextStart,
    end: ciphertextEnd,
  });
  try {
    await pipeline(ciphertext, decipher, createGunzip(), child.stdin);
    const exitCode = await exit;
    if (exitCode !== 0) throw new Error('psql restore failed');
  } catch {
    child.kill('SIGTERM');
    await exit.catch(() => 1);
    throw new Error('Encrypted PostgreSQL restore failed');
  }
}
