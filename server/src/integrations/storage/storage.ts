import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export interface StoredObject {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}
export interface Storage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  presignPut(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresSeconds: number,
  ): Promise<string>;
  presignGet(
    key: string,
    expiresSeconds: number,
    downloadName?: string,
  ): Promise<string>;
}

export class MemoryStorage implements Storage {
  private readonly objects = new Map<string, StoredObject>();
  put(key: string, bytes: Uint8Array, contentType: string) {
    this.objects.set(key, { key, bytes: new Uint8Array(bytes), contentType });
    return Promise.resolve();
  }
  get(key: string) {
    const value = this.objects.get(key);
    return Promise.resolve(
      value ? { ...value, bytes: new Uint8Array(value.bytes) } : null,
    );
  }
  delete(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }
  presignPut(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresSeconds: number,
  ) {
    const query = new URLSearchParams({
      type: contentType,
      max: String(maxBytes),
      expires: String(expiresSeconds),
    });
    return Promise.resolve(
      `memory://upload/${encodeURIComponent(key)}?${query}`,
    );
  }
  presignGet(key: string, expiresSeconds: number, downloadName?: string) {
    const query = new URLSearchParams({
      expires: String(expiresSeconds),
      ...(downloadName ? { name: downloadName } : {}),
    });
    return Promise.resolve(
      `memory://download/${encodeURIComponent(key)}?${query}`,
    );
  }
}

export class LocalDiskStorage implements Storage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    const path = resolve(this.root, key);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`))
      throw new Error('Invalid storage key');
    return path;
  }
  async put(key: string, bytes: Uint8Array, contentType: string) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
    await writeFile(`${path}.content-type`, contentType, { mode: 0o600 });
  }
  async get(key: string) {
    try {
      return {
        key,
        bytes: await readFile(this.path(key)),
        contentType: 'application/octet-stream',
      };
    } catch (e) {
      if (isCode(e, 'ENOENT')) return null;
      throw e;
    }
  }
  async delete(key: string) {
    try {
      await rm(this.path(key));
    } catch (e) {
      if (!isCode(e, 'ENOENT')) throw e;
    }
  }
  presignPut(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresSeconds: number,
  ) {
    const query = new URLSearchParams({
      type: contentType,
      max: String(maxBytes),
      expires: String(expiresSeconds),
    });
    return Promise.resolve(
      `local://upload/${encodeURIComponent(key)}?${query}`,
    );
  }
  presignGet(key: string, expiresSeconds: number, downloadName?: string) {
    const query = new URLSearchParams({
      expires: String(expiresSeconds),
      ...(downloadName ? { name: downloadName } : {}),
    });
    return Promise.resolve(
      `local://download/${encodeURIComponent(key)}?${query}`,
    );
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

/** S3-compatible storage. A gateway signer keeps credentials server-side and supports R2/MinIO/S3 endpoints. */
export interface S3ObjectClient {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  presignPut(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresSeconds: number,
  ): Promise<string>;
  presignGet(
    key: string,
    expiresSeconds: number,
    downloadName?: string,
  ): Promise<string>;
}
export class S3Storage implements Storage {
  constructor(private readonly client: S3ObjectClient) {}
  put(key: string, bytes: Uint8Array, contentType: string) {
    return this.client.put(key, bytes, contentType);
  }
  get(key: string) {
    return this.client.get(key);
  }
  delete(key: string) {
    return this.client.delete(key);
  }
  presignPut(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresSeconds: number,
  ) {
    return this.client.presignPut(key, contentType, maxBytes, expiresSeconds);
  }
  presignGet(key: string, expiresSeconds: number, downloadName?: string) {
    return this.client.presignGet(key, expiresSeconds, downloadName);
  }
}

export function createStorageKey(
  orgId: string | null,
  purpose: string,
  extension: string,
): string {
  const id = randomUUID();
  return `${orgId ?? 'public'}/${purpose}/${id}.${extension}`;
}
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}
/** Minimal AWS Signature V4 client for S3, R2 and compatible path-style endpoints. */
export class S3CompatibleObjectClient implements S3ObjectClient {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly config: {
      endpoint: string;
      bucket: string;
      region: string;
      credentials: S3Credentials;
      fetch?: typeof fetch;
      clock?: () => Date;
    },
  ) {
    this.endpoint = new URL(config.endpoint);
    if (
      this.endpoint.protocol !== 'https:' &&
      this.endpoint.hostname !== 'localhost' &&
      this.endpoint.hostname !== '127.0.0.1'
    )
      throw new Error('S3 endpoint must use HTTPS');
    if (
      !config.bucket ||
      !config.region ||
      !config.credentials.accessKeyId ||
      !config.credentials.secretAccessKey
    )
      throw new Error('S3 configuration is incomplete');
    this.fetcher = config.fetch ?? fetch;
  }
  private path(key: string): string {
    if (
      key.startsWith('/') ||
      key.split('/').some((part) => part === '..' || part === '.')
    )
      throw new Error('Invalid storage key');
    const prefix = this.endpoint.pathname.replace(/\/$/, '');
    return `${prefix}/${encodeURIComponent(this.config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  private timestamp() {
    return (this.config.clock?.() ?? new Date())
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, '');
  }
  private scope(amzDate: string) {
    return `${amzDate.slice(0, 8)}/${this.config.region}/s3/aws4_request`;
  }
  private signingKey(amzDate: string) {
    const dateKey = hmac(
      `AWS4${this.config.credentials.secretAccessKey}`,
      amzDate.slice(0, 8),
    );
    return hmac(hmac(hmac(dateKey, this.config.region), 's3'), 'aws4_request');
  }
  private canonicalQuery(params: URLSearchParams): string {
    return [...params.entries()]
      .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
      .sort(
        ([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv),
      )
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
  }
  private url(key: string) {
    const url = new URL(this.endpoint);
    url.pathname = this.path(key);
    return url;
  }
  private authorization(
    method: string,
    url: URL,
    headers: Record<string, string>,
    payloadHash: string,
    amzDate: string,
  ): string {
    const normalized = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key.toLowerCase(),
        value.trim().replace(/\s+/g, ' '),
      ]),
    );
    const signedHeaders = Object.keys(normalized).sort().join(';');
    const canonicalHeaders = Object.keys(normalized)
      .sort()
      .map((name) => `${name}:${normalized[name] ?? ''}\n`)
      .join('');
    const canonical = [
      method,
      url.pathname,
      this.canonicalQuery(url.searchParams),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = this.scope(amzDate);
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n');
    const signature = createHmac('sha256', this.signingKey(amzDate))
      .update(stringToSign)
      .digest('hex');
    return `AWS4-HMAC-SHA256 Credential=${this.config.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }
  private presign(
    method: 'GET' | 'PUT',
    key: string,
    expiresSeconds: number,
    extra: Record<string, string> = {},
    contentLength?: number,
  ): string {
    if (
      !Number.isInteger(expiresSeconds) ||
      expiresSeconds < 1 ||
      expiresSeconds > 604800
    )
      throw new Error(
        'Presigned URL expiry must be between 1 second and 7 days',
      );
    const url = this.url(key);
    const amzDate = this.timestamp();
    const scope = this.scope(amzDate);
    const signedHeaders =
      method === 'PUT' ? 'content-length;content-type;host' : 'host';
    const params = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.credentials.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': signedHeaders,
      ...extra,
    });
    const canonicalHeaders =
      method === 'PUT'
        ? `content-length:${String(contentLength ?? 0)}\ncontent-type:${extra['content-type'] ?? ''}\nhost:${url.host}\n`
        : `host:${url.host}\n`;
    const canonical = [
      method,
      url.pathname,
      this.canonicalQuery(params),
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const toSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n');
    params.set(
      'X-Amz-Signature',
      createHmac('sha256', this.signingKey(amzDate))
        .update(toSign)
        .digest('hex'),
    );
    url.search = this.canonicalQuery(params);
    return url.toString();
  }
  async put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const url = this.url(key);
    const amzDate = this.timestamp();
    const payloadHash = createHash('sha256').update(bytes).digest('hex');
    const headers = {
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'content-type': contentType,
    };
    const response = await this.fetcher(url, {
      method: 'PUT',
      headers: {
        ...headers,
        authorization: this.authorization(
          'PUT',
          url,
          headers,
          payloadHash,
          amzDate,
        ),
      },
      body: Buffer.from(bytes),
    });
    if (!response.ok)
      throw new Error(`S3 upload failed with HTTP ${String(response.status)}`);
  }
  async get(key: string): Promise<StoredObject | null> {
    const url = this.url(key);
    const amzDate = this.timestamp();
    const payloadHash = createHash('sha256').update('').digest('hex');
    const headers = {
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    const response = await this.fetcher(url, {
      headers: {
        ...headers,
        authorization: this.authorization(
          'GET',
          url,
          headers,
          payloadHash,
          amzDate,
        ),
      },
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `S3 download failed with HTTP ${String(response.status)}`,
      );
    return {
      key,
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType:
        response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
  async delete(key: string): Promise<void> {
    const url = this.url(key);
    const amzDate = this.timestamp();
    const payloadHash = createHash('sha256').update('').digest('hex');
    const headers = {
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    const response = await this.fetcher(url, {
      method: 'DELETE',
      headers: {
        ...headers,
        authorization: this.authorization(
          'DELETE',
          url,
          headers,
          payloadHash,
          amzDate,
        ),
      },
    });
    if (!response.ok && response.status !== 404)
      throw new Error(`S3 delete failed with HTTP ${String(response.status)}`);
  }
  presignPut(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresSeconds: number,
  ) {
    return Promise.resolve(
      this.presign(
        'PUT',
        key,
        expiresSeconds,
        { 'content-type': contentType },
        maxBytes,
      ),
    );
  }
  presignGet(key: string, expiresSeconds: number, downloadName?: string) {
    return Promise.resolve(
      this.presign(
        'GET',
        key,
        expiresSeconds,
        downloadName
          ? {
              'response-content-disposition': `attachment; filename="${downloadName.replace(/["\\\r\n]/g, '')}"`,
            }
          : {},
      ),
    );
  }
}
function hmac(key: string | Uint8Array, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}
function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
