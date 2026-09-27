import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import type { ImageProcessor } from '../../integrations/storage/image-processor';
import type { Storage } from '../../integrations/storage/storage';
import { createStorageKey, sha256 } from '../../integrations/storage/storage';

export type FilePurpose = 'image' | 'document' | 'import' | 'website_asset';
export interface FileRecord {
  id: string;
  orgId: string | null;
  purpose: FilePurpose;
  ownerType: string | null;
  ownerId: string | null;
  storageKey: string;
  mime: string;
  bytes: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  sensitivity: string;
  createdBy: string;
  uploadState: 'pending' | 'complete' | 'rejected';
}
export interface FileAuthorization {
  canUpload(
    context: OrgContext,
    purpose: FilePurpose,
    ownerType?: string,
    ownerId?: string,
  ): Promise<boolean>;
  canDownload(context: OrgContext, file: FileRecord): Promise<boolean>;
}
export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileValidationError';
  }
}
export class FilePermissionError extends Error {
  constructor() {
    super('Upload is not permitted');
    this.name = 'FilePermissionError';
  }
}

const rules: Record<FilePurpose, { max: number; mime: readonly string[] }> = {
  image: {
    max: 15 * 1024 * 1024,
    mime: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  },
  website_asset: {
    max: 15 * 1024 * 1024,
    mime: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  },
  document: {
    max: 15 * 1024 * 1024,
    mime: ['application/pdf', 'image/jpeg', 'image/png'],
  },
  import: {
    max: 20 * 1024 * 1024,
    mime: [
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  },
};

export function sniffMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    Buffer.from(bytes.slice(1, 4)).toString() === 'PNG'
  )
    return 'image/png';
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.slice(0, 4)).toString() === 'RIFF' &&
    Buffer.from(bytes.slice(8, 12)).toString() === 'WEBP'
  )
    return 'image/webp';
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.slice(4, 8)).toString() === 'ftyp' &&
    /^(heic|heix|hevc|hevx|mif1)$/.test(
      Buffer.from(bytes.slice(8, 12)).toString(),
    )
  )
    return 'image/heic';
  if (
    bytes.length >= 5 &&
    Buffer.from(bytes.slice(0, 5)).toString() === '%PDF-'
  )
    return 'application/pdf';
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.slice(0, 4)).toString() === 'PK\x03\x04'
  )
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  try {
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, '');
    if (text.includes(',') && isCsvText(text)) return 'text/csv';
  } catch {
    /* Invalid text encoding is not CSV. */
  }
  return null;
}

function isCsvText(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code !== 9 && code !== 10 && code !== 13 && code < 32) return false;
  }
  return true;
}

async function getRecord(
  trx: OrgTransaction,
  id: string,
): Promise<FileRecord | null> {
  const result =
    await sql<FileRecord>`select id, org_id as "orgId", purpose, owner_type as "ownerType", owner_id as "ownerId", storage_key as "storageKey", mime, bytes, sha256, width, height, sensitivity, created_by as "createdBy", upload_state as "uploadState" from files where id = ${id} and deleted_at is null`.execute(
      trx,
    );
  return result.rows[0] ?? null;
}

export class FilesService {
  constructor(
    private readonly storage: Storage,
    private readonly authorization: FileAuthorization,
    private readonly processor?: ImageProcessor,
    private readonly tenantScope: typeof withOrg = withOrg,
  ) {}

  async beginUpload(input: {
    context: OrgContext;
    purpose: FilePurpose;
    mime: string;
    bytes: number;
    ownerType?: string;
    ownerId?: string;
    sensitivity?: string;
  }): Promise<{ fileId: string; uploadUrl: string }> {
    const rule = rules[input.purpose];
    if (
      !rule.mime.includes(input.mime) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > rule.max
    )
      throw new FileValidationError(
        'File type or size is not allowed for this purpose',
      );
    if (
      !(await this.authorization.canUpload(
        input.context,
        input.purpose,
        input.ownerType,
        input.ownerId,
      ))
    )
      throw new FilePermissionError();
    const fileId = randomUUID();
    const extension =
      input.mime === 'image/jpeg'
        ? 'jpg'
        : input.mime === 'image/png'
          ? 'png'
          : input.mime === 'image/webp'
            ? 'webp'
            : input.mime === 'application/pdf'
              ? 'pdf'
              : input.mime === 'text/csv'
                ? 'csv'
                : input.mime.includes('spreadsheet')
                  ? 'xlsx'
                  : 'heic';
    const key = createStorageKey(input.context.orgId, input.purpose, extension);
    await this.tenantScope(input.context, async (trx) => {
      await sql`insert into files (id, org_id, purpose, owner_type, owner_id, storage_key, mime, bytes, sensitivity, created_by, expires_at) values (${fileId}, ${input.context.orgId}, ${input.purpose}, ${input.ownerType ?? null}, ${input.ownerId ?? null}, ${key}, ${input.mime}, ${input.bytes}, ${input.sensitivity ?? 'internal'}, ${input.context.actor.accountId}, now() + interval '1 hour')`.execute(
        trx,
      );
      await sql`insert into audit_log (id, org_id, actor_account_id, action, entity_type, entity_id, changes) values (${randomUUID()}, ${input.context.orgId}, ${input.context.actor.accountId}, 'file.upload.started', 'file', ${fileId}, ${JSON.stringify({ purpose: input.purpose, mime: input.mime, bytes: input.bytes })}::jsonb)`.execute(
        trx,
      );
    });
    try {
      const presigned = await this.storage.presignPut(
        key,
        input.mime,
        input.bytes,
        900,
      );
      const uploadUrl =
        presigned.startsWith('local://') || presigned.startsWith('memory://')
          ? `/api/v1/files/uploads/${fileId}/content`
          : presigned;
      return { fileId, uploadUrl };
    } catch (error) {
      await this.reject(input.context, fileId);
      throw error;
    }
  }

  async completeUpload(
    context: OrgContext,
    fileId: string,
  ): Promise<FileRecord> {
    const record = await this.tenantScope(context, async (trx) =>
      getRecord(trx, fileId),
    );
    if (!record || record.uploadState !== 'pending')
      throw new FileValidationError('Upload not found or no longer pending');
    if (
      !(await this.authorization.canUpload(
        context,
        record.purpose,
        record.ownerType ?? undefined,
        record.ownerId ?? undefined,
      ))
    )
      throw new FilePermissionError();
    const object = await this.storage.get(record.storageKey);
    if (
      !object ||
      object.bytes.byteLength !== record.bytes ||
      sniffMime(object.bytes) !== record.mime
    ) {
      await this.reject(context, fileId);
      throw new FileValidationError(
        'Uploaded file did not match its declared size or content type',
      );
    }
    let bytes = object.bytes;
    let mime = record.mime;
    let width: number | null = null;
    let height: number | null = null;
    if (record.purpose === 'image' || record.purpose === 'website_asset') {
      if (!this.processor)
        throw new Error('Image processing dependency is not configured');
      const processed = await this.processor.process(bytes, mime);
      bytes = processed.bytes;
      mime = processed.mime;
      width = processed.width;
      height = processed.height;
      await this.storage.put(record.storageKey, bytes, mime);
      const base = record.storageKey.replace(/\.[^.]+$/, '');
      await Promise.all([
        this.storage.put(`${base}-medium.webp`, processed.medium, 'image/webp'),
        this.storage.put(
          `${base}-thumbnail.webp`,
          processed.thumbnail,
          'image/webp',
        ),
      ]);
    }
    const digest = sha256(bytes);
    return this.tenantScope(context, async (trx) => {
      const result =
        await sql<FileRecord>`update files set upload_state = 'complete', mime = ${mime}, bytes = ${bytes.byteLength}, sha256 = ${digest}, width = ${width}, height = ${height} where id = ${fileId} and upload_state = 'pending' and expires_at > now() returning id, org_id as "orgId", purpose, owner_type as "ownerType", owner_id as "ownerId", storage_key as "storageKey", mime, bytes, sha256, width, height, sensitivity, created_by as "createdBy", upload_state as "uploadState"`.execute(
          trx,
        );
      const completed = result.rows[0];
      if (!completed) throw new FileValidationError('Upload expired');
      await sql`insert into audit_log (id, org_id, actor_account_id, action, entity_type, entity_id, changes) values (${randomUUID()}, ${context.orgId}, ${context.actor.accountId}, 'file.upload.completed', 'file', ${fileId}, ${JSON.stringify({ mime, bytes: bytes.byteLength, sha256: digest })}::jsonb)`.execute(
        trx,
      );
      return completed;
    });
  }

  async uploadLocalBytes(
    context: OrgContext,
    fileId: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const record = await this.tenantScope(context, async (trx) =>
      getRecord(trx, fileId),
    );
    if (
      !record ||
      record.uploadState !== 'pending' ||
      bytes.byteLength !== record.bytes ||
      sniffMime(bytes) !== record.mime
    ) {
      await this.reject(context, fileId);
      throw new FileValidationError(
        'Uploaded file did not match its declared size or content type',
      );
    }
    if (
      !(await this.authorization.canUpload(
        context,
        record.purpose,
        record.ownerType ?? undefined,
        record.ownerId ?? undefined,
      ))
    )
      throw new FilePermissionError();
    await this.storage.put(record.storageKey, bytes, record.mime);
  }

  async readLocalContent(
    context: OrgContext,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; mime: string }> {
    const record = await this.tenantScope(context, async (trx) =>
      getRecord(trx, fileId),
    );
    if (
      !record ||
      record.uploadState !== 'complete' ||
      !(await this.authorization.canDownload(context, record))
    )
      throw new FileValidationError('File not found');
    const object = await this.storage.get(record.storageKey);
    if (!object) throw new FileValidationError('File not found');
    await this.tenantScope(context, async (trx) => {
      await sql`insert into audit_log (id, org_id, actor_account_id, action, entity_type, entity_id, changes) values (${randomUUID()}, ${context.orgId}, ${context.actor.accountId}, 'file.downloaded', 'file', ${fileId}, '{}'::jsonb)`.execute(
        trx,
      );
    });
    return { bytes: object.bytes, mime: record.mime };
  }

  async download(context: OrgContext, fileId: string): Promise<string> {
    const record = await this.tenantScope(context, async (trx) =>
      getRecord(trx, fileId),
    );
    if (
      !record ||
      record.uploadState !== 'complete' ||
      !(await this.authorization.canDownload(context, record))
    )
      throw new FileValidationError('File not found');
    await this.tenantScope(context, async (trx) => {
      await sql`insert into audit_log (id, org_id, actor_account_id, action, entity_type, entity_id, changes) values (${randomUUID()}, ${context.orgId}, ${context.actor.accountId}, 'file.download.link_issued', 'file', ${fileId}, '{}'::jsonb)`.execute(
        trx,
      );
    });
    const presigned = await this.storage.presignGet(
      record.storageKey,
      300,
      'attachment',
    );
    return presigned.startsWith('local://') || presigned.startsWith('memory://')
      ? `/api/v1/files/${fileId}/content`
      : presigned;
  }

  private async reject(context: OrgContext, fileId: string) {
    await this.tenantScope(context, async (trx) => {
      await sql`update files set upload_state = 'rejected' where id = ${fileId} and upload_state = 'pending'`.execute(
        trx,
      );
    });
  }
}
