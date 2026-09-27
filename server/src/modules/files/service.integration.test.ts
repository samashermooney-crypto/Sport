import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { MemoryStorage } from '../../integrations/storage/storage';

import type { FileAuthorization } from './service';
import { FileValidationError, FilesService } from './service';

const orgA = randomUUID();
const orgB = randomUUID();
const accountA = randomUUID();
const accountB = randomUUID();
const contextA: OrgContext = { orgId: orgA, actor: { accountId: accountA } };
const contextB: OrgContext = { orgId: orgB, actor: { accountId: accountB } };
const storage = new MemoryStorage();
const authorization: FileAuthorization = {
  canUpload: () => Promise.resolve(true),
  canDownload: () => Promise.resolve(true),
};
let service: FilesService;
let database: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO organizations (id, slug, name, kind, timezone)
       VALUES ($1, $2, 'File Test A', 'club', 'America/Chicago'),
              ($3, $4, 'File Test B', 'club', 'America/Chicago')`,
      [
        orgA,
        `files-a-${orgA.slice(0, 8)}`,
        orgB,
        `files-b-${orgB.slice(0, 8)}`,
      ],
    );
    await admin.query(
      `INSERT INTO accounts (id, email, first_name, last_name, date_of_birth)
       VALUES ($1, $2, 'File', 'Actor A', '1980-01-01'),
              ($3, $4, 'File', 'Actor B', '1980-01-01')`,
      [
        accountA,
        `${accountA}@example.test`,
        accountB,
        `${accountB}@example.test`,
      ],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  service = new FilesService(
    storage,
    authorization,
    undefined,
    createWithOrg(database),
  );
});

afterAll(async () => {
  await database.destroy();
});

describe('files tenancy and lifecycle', () => {
  it('validates, completes, and audits a local preview upload', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7');
    const pending = await service.beginUpload({
      context: contextA,
      purpose: 'document',
      mime: 'application/pdf',
      bytes: bytes.byteLength,
    });
    expect(pending.uploadUrl).toBe(
      `/api/v1/files/uploads/${pending.fileId}/content`,
    );
    await service.uploadLocalBytes(contextA, pending.fileId, bytes);
    const completed = await service.completeUpload(contextA, pending.fileId);
    expect(completed.uploadState).toBe('complete');
    expect(completed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await service.download(contextA, pending.fileId)).toBe(
      `/api/v1/files/${pending.fileId}/content`,
    );
    await expect(
      service.readLocalContent(contextA, pending.fileId),
    ).resolves.toMatchObject({ mime: 'application/pdf', bytes });
    const rows = await createWithOrg(database)(contextA, async (trx) =>
      trx
        .selectFrom('audit_log')
        .select('action')
        .where('entity_id', '=', pending.fileId)
        .execute(),
    );
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'file.upload.started',
        'file.upload.completed',
        'file.download.link_issued',
        'file.downloaded',
      ]),
    );
  });

  it('cannot locate or download another organization’s file through withOrg', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7');
    const pending = await service.beginUpload({
      context: contextA,
      purpose: 'document',
      mime: 'application/pdf',
      bytes: bytes.byteLength,
    });
    await service.uploadLocalBytes(contextA, pending.fileId, bytes);
    await service.completeUpload(contextA, pending.fileId);
    await expect(
      service.download(contextB, pending.fileId),
    ).rejects.toBeInstanceOf(FileValidationError);
    await expect(
      service.readLocalContent(contextB, pending.fileId),
    ).rejects.toBeInstanceOf(FileValidationError);
  });
});
