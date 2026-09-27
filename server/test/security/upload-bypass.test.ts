import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/db/kysely';
import type { DB } from '../../src/db/types';
import { createWithOrg } from '../../src/db/withOrg';
import { MemoryStorage } from '../../src/integrations/storage/storage';
import { createFilesAuthorization } from '../../src/modules/files/module';
import {
  FileValidationError,
  FilesService,
} from '../../src/modules/files/service';
import { createTestFactories } from '../factories';

let database: Kysely<DB>;
let service: FilesService;
let context: Awaited<
  ReturnType<ReturnType<typeof createTestFactories>['actor']>
>;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  context = await createTestFactories(database).actor();
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.accountId)
      .execute();
  });
  service = new FilesService(
    new MemoryStorage(),
    createFilesAuthorization(database),
    undefined,
    createWithOrg(database),
  );
});

afterAll(async () => {
  await database.destroy();
});

describe('upload validation bypasses', () => {
  it('rejects declared sizes beyond the purpose limit', async () => {
    await expect(
      service.beginUpload({
        context,
        purpose: 'document',
        mime: 'application/pdf',
        bytes: 15 * 1024 * 1024 + 1,
      }),
    ).rejects.toBeInstanceOf(FileValidationError);
  });

  it('rejects HTML bytes uploaded under an allowed PDF content type', async () => {
    const spoofed = new TextEncoder().encode('<script>');
    const pending = await service.beginUpload({
      context,
      purpose: 'document',
      mime: 'application/pdf',
      bytes: spoofed.byteLength,
    });

    await expect(
      service.uploadLocalBytes(context, pending.fileId, spoofed),
    ).rejects.toThrow('did not match its declared size or content type');
    await expect(
      service.completeUpload(context, pending.fileId),
    ).rejects.toBeInstanceOf(FileValidationError);
  });
});
