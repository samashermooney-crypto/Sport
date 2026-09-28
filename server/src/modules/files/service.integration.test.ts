import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import {
  fileRecordResponseSchema,
  fileUploadResultSchema,
} from '@shared/schemas/files';
import express from 'express';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { SharpImageProcessor } from '../../integrations/storage/image-processor';
import { MemoryStorage } from '../../integrations/storage/storage';

import {
  createFilesAuthorization,
  createPublicFacilityLayoutReader,
  createPublicSponsorLogoReader,
} from './module';
import { createFilesRouter } from './routes';
import type { FileAuthorization } from './service';
import {
  FilePermissionError,
  FileValidationError,
  FilesService,
} from './service';

const orgA = randomUUID();
const orgB = randomUUID();
const orgASlug = `files-a-${orgA.slice(0, 8)}`;
const orgBSlug = `files-b-${orgB.slice(0, 8)}`;
const accountA = randomUUID();
const accountB = randomUUID();
const guardianAccount = randomUUID();
const complianceAccount = randomUUID();
const adminAccount = randomUUID();
const unverifiedGuardianAccount = randomUUID();
const chatMemberAccount = randomUUID();
const otherChatMemberAccount = randomUUID();
const revokedChatMemberAccount = randomUUID();
const personA = randomUUID();
const personB = randomUUID();
const injuryReportId = randomUUID();
const chatConversationId = randomUUID();
const otherChatConversationId = randomUUID();
const archivedChatConversationId = randomUUID();
const revokedChatConversationId = randomUUID();
const publicFacilityId = randomUUID();
const publicLayoutFileId = randomUUID();
const contextA: OrgContext = { orgId: orgA, actor: { accountId: accountA } };
const contextB: OrgContext = { orgId: orgB, actor: { accountId: accountB } };
const guardianContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: guardianAccount },
};
const complianceContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: complianceAccount },
};
const adminContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: adminAccount },
};
const unverifiedGuardianContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: unverifiedGuardianAccount },
};
const chatMemberContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: chatMemberAccount },
};
const otherChatMemberContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: otherChatMemberAccount },
};
const revokedChatMemberContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: revokedChatMemberAccount },
};
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
      [orgA, orgASlug, orgB, orgBSlug],
    );
    await admin.query(
      `INSERT INTO accounts (id, email, first_name, last_name, date_of_birth)
       VALUES ($1, $2, 'File', 'Actor A', '1980-01-01'),
              ($3, $4, 'File', 'Actor B', '1980-01-01'),
              ($5, $6, 'File', 'Guardian', '1980-01-01'),
              ($7, $8, 'File', 'Compliance', '1980-01-01'),
              ($9, $10, 'File', 'Admin', '1980-01-01'),
              ($11, $12, 'File', 'Unverified', '1980-01-01'),
              ($13, $14, 'Chat', 'Member', '1980-01-01'),
              ($15, $16, 'Chat', 'Other Member', '1980-01-01'),
              ($17, $18, 'Chat', 'Revoked Member', '1980-01-01')`,
      [
        accountA,
        `${accountA}@example.test`,
        accountB,
        `${accountB}@example.test`,
        guardianAccount,
        `${guardianAccount}@example.test`,
        complianceAccount,
        `${complianceAccount}@example.test`,
        adminAccount,
        `${adminAccount}@example.test`,
        unverifiedGuardianAccount,
        `${unverifiedGuardianAccount}@example.test`,
        chatMemberAccount,
        `${chatMemberAccount}@example.test`,
        otherChatMemberAccount,
        `${otherChatMemberAccount}@example.test`,
        revokedChatMemberAccount,
        `${revokedChatMemberAccount}@example.test`,
      ],
    );
    await admin.query(
      `INSERT INTO people (id, org_id, first_name, last_name, date_of_birth)
       VALUES ($1, $2, 'Person', 'A', '2015-01-01'),
              ($3, $4, 'Person', 'B', '2015-01-01')`,
      [personA, orgA, personB, orgB],
    );
    await admin.query(
      `INSERT INTO injury_reports (id, org_id, person_id, occurred_at, reported_by)
       VALUES ($1, $2, $3, now(), $4)`,
      [injuryReportId, orgA, personA, guardianAccount],
    );
    await admin.query(
      `INSERT INTO org_memberships (id, org_id, account_id, status, joined_at)
       VALUES ($1, $2, $3, 'active', now()),
              ($4, $2, $5, 'active', now()),
              ($6, $2, $7, 'active', now()),
              ($8, $2, $9, 'active', now()),
              ($10, $2, $11, 'active', now()),
              ($12, $13, $14, 'active', now())`,
      [
        randomUUID(),
        orgA,
        accountA,
        randomUUID(),
        guardianAccount,
        randomUUID(),
        complianceAccount,
        randomUUID(),
        adminAccount,
        randomUUID(),
        unverifiedGuardianAccount,
        randomUUID(),
        orgB,
        accountB,
      ],
    );
    await admin.query(
      `INSERT INTO role_assignments (id, org_id, account_id, role, scope_type, granted_by, pending_mfa)
       VALUES ($1, $2, $3, 'owner', 'org', $3, false),
              ($4, $2, $5, 'compliance', 'org', $3, false),
              ($6, $2, $7, 'admin', 'org', $3, false)`,
      [
        randomUUID(),
        orgA,
        accountA,
        randomUUID(),
        complianceAccount,
        randomUUID(),
        adminAccount,
      ],
    );
    await admin.query(
      `INSERT INTO person_account_links (id, org_id, person_id, account_id, relationship, verified_at)
       VALUES ($1, $2, $3, $4, 'guardian', now()),
              ($5, $2, $3, $6, 'guardian', null)`,
      [
        randomUUID(),
        orgA,
        personA,
        guardianAccount,
        randomUUID(),
        unverifiedGuardianAccount,
      ],
    );
    await admin.query(
      `INSERT INTO conversations (id, org_id, kind, title, created_by, archived_at)
       VALUES ($1, $2, 'group', 'Chat file access', $3, NULL),
              ($4, $2, 'group', 'Other chat file access', $3, NULL),
              ($5, $2, 'group', 'Archived chat file access', $3, now()),
              ($6, $2, 'group', 'Revoked chat file access', $3, NULL)`,
      [
        chatConversationId,
        orgA,
        accountA,
        otherChatConversationId,
        archivedChatConversationId,
        revokedChatConversationId,
      ],
    );
    await admin.query(
      `INSERT INTO conversation_members (id, org_id, conversation_id, account_id, role, revoked_at)
       VALUES ($1, $2, $3, $4, 'member', NULL),
              ($5, $2, $6, $7, 'member', NULL),
              ($8, $2, $9, $10, 'member', NULL),
              ($11, $2, $12, $13, 'member', now())`,
      [
        randomUUID(),
        orgA,
        chatConversationId,
        chatMemberAccount,
        randomUUID(),
        otherChatConversationId,
        otherChatMemberAccount,
        randomUUID(),
        archivedChatConversationId,
        revokedChatMemberAccount,
        randomUUID(),
        revokedChatConversationId,
        revokedChatMemberAccount,
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
  it('uses shared file route contracts without returning storage metadata', async () => {
    const app = express();
    app.use(
      createFilesRouter({
        files: service,
        context: () => Promise.resolve(contextA),
        publicFacilityLayout: () => Promise.resolve(null),
        publicSponsorLogo: () => Promise.resolve(null),
      }),
    );
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Files route test server did not bind to a TCP port');
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;
    const bytes = Buffer.from('%PDF-1.7\nroute-contract\n');
    try {
      const started = await fetch(`${baseUrl}/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'document',
          mime: 'application/pdf',
          bytes: bytes.byteLength,
        }),
      });
      expect(started.status).toBe(201);
      const { fileId } = fileUploadResultSchema.parse(await started.json());

      const uploaded = await fetch(`${baseUrl}/uploads/${fileId}/content`, {
        method: 'PUT',
        headers: { 'content-type': 'application/pdf' },
        body: new Uint8Array(bytes),
      });
      expect(uploaded.status).toBe(204);

      const completed = await fetch(`${baseUrl}/uploads/${fileId}/complete`, {
        method: 'POST',
      });
      expect(completed.status).toBe(200);
      const record = fileRecordResponseSchema.parse(await completed.json());
      expect(record).toMatchObject({
        id: fileId,
        orgId: orgA,
        purpose: 'document',
        mime: 'application/pdf',
        uploadState: 'complete',
      });
      expect(record).not.toHaveProperty('storageKey');
      expect(record).not.toHaveProperty('createdBy');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it.each(['image', 'document'] as const)(
    'strips GPS and EXIF from %s images and every stored size',
    async (purpose) => {
      const source = await readFile(
        new URL('../../../test/fixtures/gps-photo.jpg', import.meta.url),
      );
      const sourceMetadata = await sharp(source).metadata();
      expect(sourceMetadata.exif).toBeDefined();
      const imageService = new FilesService(
        storage,
        authorization,
        new SharpImageProcessor(),
        createWithOrg(database),
      );
      const pending = await imageService.beginUpload({
        context: contextA,
        purpose,
        mime: 'image/jpeg',
        bytes: source.byteLength,
      });
      await imageService.uploadLocalBytes(contextA, pending.fileId, source);
      const completed = await imageService.completeUpload(
        contextA,
        pending.fileId,
      );
      expect(completed.mime).toBe('image/webp');
      const primary = await imageService.readLocalContent(
        contextA,
        pending.fileId,
      );
      const base = completed.storageKey.replace(/\.[^.]+$/, '');
      const variants = [
        primary.bytes,
        (await storage.get(`${base}-medium.webp`))?.bytes,
        (await storage.get(`${base}-thumbnail.webp`))?.bytes,
      ];
      for (const bytes of variants) {
        if (!bytes) throw new Error('Processed image variant is missing');
        const metadata = await sharp(bytes).metadata();
        expect(metadata.exif).toBeUndefined();
        expect(metadata.xmp).toBeUndefined();
        expect(metadata.iptc).toBeUndefined();
      }
    },
  );

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

  it('serves layout images only from active public facilities and public image assets', async () => {
    const bytes = Buffer.from('RIFF0000WEBP');
    const storageKey = `${orgA}/website_asset/${publicLayoutFileId}.webp`;
    await storage.put(storageKey, bytes, 'image/webp');
    await database
      .updateTable('organizations')
      .set({ status: 'active' })
      .where('id', '=', orgA)
      .execute();
    await createWithOrg(database)(contextA, async (trx) => {
      await trx
        .insertInto('files')
        .values({
          id: publicLayoutFileId,
          org_id: orgA,
          purpose: 'website_asset',
          owner_type: null,
          owner_id: null,
          storage_key: storageKey,
          mime: 'image/webp',
          bytes: bytes.byteLength,
          sha256: null,
          width: 1,
          height: 1,
          sensitivity: 'public',
          created_by: accountA,
          upload_state: 'complete',
          deleted_at: null,
        })
        .execute();
      await trx
        .insertInto('facilities')
        .values({
          id: publicFacilityId,
          org_id: orgA,
          name: 'Public Layout Facility',
          address: null,
          lat: null,
          lng: null,
          timezone: 'America/Chicago',
          ownership: 'owned',
          notes_html: null,
          parking_notes: null,
          map_url: null,
          public: true,
          archived_at: null,
          layout_image_file_id: publicLayoutFileId,
        })
        .execute();
    });

    const readLayout = createPublicFacilityLayoutReader(database, service);
    const storedLayout = await readLayout(orgASlug, publicFacilityId);
    expect(storedLayout?.mime).toBe('image/webp');
    expect(Buffer.from(storedLayout?.bytes ?? [])).toEqual(bytes);

    const app = express();
    app.use(
      createFilesRouter({
        files: service,
        context: () => Promise.resolve(contextA),
        publicFacilityLayout: readLayout,
        publicSponsorLogo: () => Promise.resolve(null),
      }),
    );
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Files test server did not bind to a TCP port');
    const url =
      `http://127.0.0.1:${String(address.port)}` +
      `/public/orgs/${orgASlug}/facilities/${publicFacilityId}/layout`;
    try {
      const visible = await fetch(url);
      expect(visible.status).toBe(200);
      expect(visible.headers.get('content-type')).toBe('image/webp');
      expect(visible.headers.get('cache-control')).toBe('no-store');
      expect(Buffer.from(await visible.arrayBuffer())).toEqual(bytes);

      const absentFile = await fetch(
        `${new URL(url).origin}/${randomUUID()}/content`,
      );
      expect(absentFile.status).toBe(404);
      expect(await absentFile.json()).toEqual({
        error: { code: 'NOT_FOUND', message: 'File not found' },
      });

      expect((await fetch(url.replace(orgASlug, orgBSlug))).status).toBe(404);
      await createWithOrg(database)(contextA, (trx) =>
        trx
          .updateTable('files')
          .set({ sensitivity: 'restricted' })
          .where('id', '=', publicLayoutFileId)
          .execute(),
      );
      expect((await fetch(url)).status).toBe(404);
      const restrictedAudit = await createWithOrg(database)(contextA, (trx) =>
        trx
          .selectFrom('audit_log')
          .select('id')
          .where('entity_id', '=', publicLayoutFileId)
          .where('action', '=', 'file.restricted.read')
          .execute(),
      );
      expect(restrictedAudit).toEqual([]);

      await createWithOrg(database)(contextA, async (trx) => {
        await trx
          .updateTable('files')
          .set({ sensitivity: 'public' })
          .where('id', '=', publicLayoutFileId)
          .execute();
        await trx
          .updateTable('facilities')
          .set({ public: false })
          .where('id', '=', publicFacilityId)
          .execute();
      });
      expect((await fetch(url)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('serves sponsor logos only for active public placements and public image files', async () => {
    const sponsorId = randomUUID();
    const logoFileId = randomUUID();
    const bytes = Buffer.from('RIFF0000WEBP');
    const storageKey = `${orgA}/website_asset/${logoFileId}.webp`;
    await storage.put(storageKey, bytes, 'image/webp');
    await createWithOrg(database)(contextA, async (trx) => {
      await trx
        .updateTable('organizations')
        .set({ status: 'active' })
        .where('id', '=', orgA)
        .execute();
      await trx
        .insertInto('files')
        .values({
          id: logoFileId,
          org_id: orgA,
          purpose: 'website_asset',
          owner_type: null,
          owner_id: null,
          storage_key: storageKey,
          mime: 'image/webp',
          bytes: bytes.byteLength,
          sha256: null,
          width: 1,
          height: 1,
          sensitivity: 'public',
          created_by: accountA,
          upload_state: 'complete',
          deleted_at: null,
        })
        .execute();
      await trx
        .insertInto('sponsors')
        .values({
          id: sponsorId,
          org_id: orgA,
          name: 'Public Sponsor',
          contact: JSON.stringify({}),
          logo_file_id: logoFileId,
          website_url: 'https://sponsor.example.test',
          tier: 'Gold',
          amount_cents: 10_000,
          contract_start: '2026-01-01',
          contract_end: '2026-12-31',
          placements: JSON.stringify([{ surface: 'website_home' }]),
          status: 'active',
          created_by: accountA,
        })
        .execute();
    });

    const publicLogo = createPublicSponsorLogoReader(
      database,
      service,
      () => new Date('2026-04-01T18:00:00.000Z'),
    );
    const app = express();
    app.use(
      createFilesRouter({
        files: service,
        context: () => Promise.resolve(contextA),
        publicFacilityLayout: () => Promise.resolve(null),
        publicSponsorLogo: publicLogo,
      }),
    );
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Sponsor logo test server did not bind to a TCP port');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const url = `${origin}/public/orgs/${orgASlug}/sponsors/${sponsorId}/logo?surface=website_home`;
    try {
      const visible = await fetch(url);
      expect(visible.status).toBe(200);
      expect(visible.headers.get('content-type')).toBe('image/webp');
      expect(visible.headers.get('cache-control')).toBe('no-store');
      expect(visible.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await visible.arrayBuffer())).toEqual(bytes);

      expect((await fetch(url.replace(orgASlug, orgBSlug))).status).toBe(404);
      expect(
        (
          await fetch(
            `${origin}/public/orgs/${orgASlug}/sponsors/${randomUUID()}/logo?surface=website_home`,
          )
        ).status,
      ).toBe(404);
      expect((await fetch(`${url}&targetId=${randomUUID()}`)).status).toBe(404);
      expect(
        (
          await fetch(
            url.replace(
              'surface=website_home',
              `surface=team_page&targetId=${randomUUID()}`,
            ),
          )
        ).status,
      ).toBe(404);

      await createWithOrg(database)(contextA, (trx) =>
        trx
          .updateTable('sponsors')
          .set({ status: 'expired' })
          .where('id', '=', sponsorId)
          .execute(),
      );
      expect((await fetch(url)).status).toBe(404);
      await createWithOrg(database)(contextA, (trx) =>
        trx
          .updateTable('sponsors')
          .set({ status: 'active', contract_end: '2026-03-31' })
          .where('id', '=', sponsorId)
          .execute(),
      );
      expect((await fetch(url)).status).toBe(404);
      await createWithOrg(database)(contextA, (trx) =>
        trx
          .updateTable('sponsors')
          .set({ contract_end: '2026-12-31' })
          .where('id', '=', sponsorId)
          .execute(),
      );

      await createWithOrg(database)(contextA, (trx) =>
        trx
          .updateTable('files')
          .set({ sensitivity: 'restricted' })
          .where('id', '=', logoFileId)
          .execute(),
      );
      expect((await fetch(url)).status).toBe(404);
      const restrictedReads = await createWithOrg(database)(contextA, (trx) =>
        trx
          .selectFrom('audit_log')
          .select('id')
          .where('entity_id', '=', logoFileId)
          .where('action', '=', 'file.restricted.read')
          .execute(),
      );
      expect(restrictedReads).toEqual([]);

      await createWithOrg(database)(contextA, (trx) =>
        trx
          .updateTable('files')
          .set({ sensitivity: 'public', purpose: 'document' })
          .where('id', '=', logoFileId)
          .execute(),
      );
      expect((await fetch(url)).status).toBe(404);
      await createWithOrg(database)(contextA, (trx) =>
        trx
          .updateTable('files')
          .set({ purpose: 'website_asset', deleted_at: new Date() })
          .where('id', '=', logoFileId)
          .execute(),
      );
      expect((await fetch(url)).status).toBe(404);
      await createWithOrg(database)(contextA, (trx) =>
        trx
          .updateTable('files')
          .set({ deleted_at: null, mime: 'image/jpeg' })
          .where('id', '=', logoFileId)
          .execute(),
      );
      expect((await fetch(url)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('limits chat image and PDF uploads and downloads to active conversation members', async () => {
    const chatService = new FilesService(
      storage,
      createFilesAuthorization(database),
      new SharpImageProcessor(),
      createWithOrg(database),
    );
    const imageBytes = await readFile(
      new URL('../../../test/fixtures/gps-photo.jpg', import.meta.url),
    );
    const imageUpload = await chatService.beginUpload({
      context: chatMemberContext,
      purpose: 'image',
      mime: 'image/jpeg',
      bytes: imageBytes.byteLength,
    });
    await chatService.uploadLocalBytes(
      chatMemberContext,
      imageUpload.fileId,
      imageBytes,
    );
    const image = await chatService.completeUpload(
      chatMemberContext,
      imageUpload.fileId,
    );
    expect(image.mime).toBe('image/webp');
    const imageBase = image.storageKey.replace(/\.[^.]+$/, '');
    for (const key of [
      image.storageKey,
      `${imageBase}-medium.webp`,
      `${imageBase}-thumbnail.webp`,
    ]) {
      const object = await storage.get(key);
      if (!object) throw new Error('Processed chat image is missing');
      const metadata = await sharp(object.bytes).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
    }

    const pdfBytes = new TextEncoder().encode('%PDF-1.7 chat attachment');
    const pdfUpload = await chatService.beginUpload({
      context: chatMemberContext,
      purpose: 'document',
      mime: 'application/pdf',
      bytes: pdfBytes.byteLength,
    });
    await chatService.uploadLocalBytes(
      chatMemberContext,
      pdfUpload.fileId,
      pdfBytes,
    );
    await chatService.completeUpload(chatMemberContext, pdfUpload.fileId);

    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO chat_messages (id, org_id, conversation_id, author_account_id, body, attachments)
         VALUES ($1, $2, $3, $4, 'Chat file', $5::jsonb)`,
        [
          randomUUID(),
          orgA,
          chatConversationId,
          chatMemberAccount,
          JSON.stringify([
            { fileId: pdfUpload.fileId, mime: 'application/pdf' },
          ]),
        ],
      );
    } finally {
      await admin.end();
    }

    await expect(
      chatService.download(chatMemberContext, pdfUpload.fileId),
    ).resolves.toBe(`/api/v1/files/${pdfUpload.fileId}/content`);
    for (const context of [
      contextA,
      otherChatMemberContext,
      revokedChatMemberContext,
    ]) {
      await expect(
        chatService.download(context, pdfUpload.fileId),
      ).rejects.toBeInstanceOf(FileValidationError);
      await expect(
        chatService.readLocalContent(context, pdfUpload.fileId),
      ).rejects.toBeInstanceOf(FileValidationError);
    }
    await expect(
      chatService.readLocalContent(chatMemberContext, pdfUpload.fileId),
    ).resolves.toMatchObject({ mime: 'application/pdf', bytes: pdfBytes });

    const scopedUpload = await chatService.beginUpload({
      context: chatMemberContext,
      purpose: 'document',
      mime: 'application/pdf',
      bytes: pdfBytes.byteLength,
      ownerType: 'conversation',
      ownerId: chatConversationId,
    });
    await chatService.uploadLocalBytes(
      chatMemberContext,
      scopedUpload.fileId,
      pdfBytes,
    );
    await chatService.completeUpload(chatMemberContext, scopedUpload.fileId);
    await expect(
      chatService.download(otherChatMemberContext, scopedUpload.fileId),
    ).rejects.toBeInstanceOf(FileValidationError);
    await expect(
      chatService.beginUpload({
        context: chatMemberContext,
        purpose: 'document',
        mime: 'application/pdf',
        bytes: pdfBytes.byteLength,
        ownerType: 'conversation',
        ownerId: archivedChatConversationId,
      }),
    ).rejects.toBeInstanceOf(FilePermissionError);
    await expect(
      chatService.beginUpload({
        context: chatMemberContext,
        purpose: 'document',
        mime: 'application/pdf',
        bytes: pdfBytes.byteLength,
        ownerType: 'conversation',
        ownerId: chatConversationId,
        sensitivity: 'restricted',
      }),
    ).rejects.toBeInstanceOf(FilePermissionError);
    await expect(
      chatService.beginUpload({
        context: unverifiedGuardianContext,
        purpose: 'document',
        mime: 'application/pdf',
        bytes: pdfBytes.byteLength,
      }),
    ).rejects.toBeInstanceOf(FilePermissionError);

    let requestContext = otherChatMemberContext;
    const app = express();
    app.use(
      createFilesRouter({
        files: chatService,
        context: () => Promise.resolve(requestContext),
        publicFacilityLayout: () => Promise.resolve(null),
        publicSponsorLogo: () => Promise.resolve(null),
      }),
    );
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Files test server did not bind to a TCP port');
    try {
      const hidden = await fetch(
        `http://127.0.0.1:${String(address.port)}/${pdfUpload.fileId}/download`,
      );
      expect(hidden.status).toBe(404);
      requestContext = chatMemberContext;
      const visible = await fetch(
        `http://127.0.0.1:${String(address.port)}/${pdfUpload.fileId}/download`,
      );
      expect(visible.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('allows verified guardians to upload person-owned restricted evidence and audits every authorized read', async () => {
    const restrictedService = new FilesService(
      storage,
      createFilesAuthorization(database),
      undefined,
      createWithOrg(database),
    );
    const bytes = new TextEncoder().encode('%PDF-1.7 restricted evidence');
    const pending = await restrictedService.beginUpload({
      context: guardianContext,
      purpose: 'document',
      mime: 'application/pdf',
      bytes: bytes.byteLength,
      ownerType: 'person_credential',
      ownerId: personA,
      sensitivity: 'restricted',
    });
    await restrictedService.uploadLocalBytes(
      guardianContext,
      pending.fileId,
      bytes,
    );
    await restrictedService.completeUpload(guardianContext, pending.fileId);

    await expect(
      restrictedService.beginUpload({
        context: unverifiedGuardianContext,
        purpose: 'document',
        mime: 'application/pdf',
        bytes: bytes.byteLength,
        ownerType: 'person_credential',
        ownerId: personA,
        sensitivity: 'restricted',
      }),
    ).rejects.toBeInstanceOf(FilePermissionError);
    await expect(
      restrictedService.beginUpload({
        context: guardianContext,
        purpose: 'document',
        mime: 'application/pdf',
        bytes: bytes.byteLength,
        ownerType: 'person_credential',
        ownerId: personB,
        sensitivity: 'restricted',
      }),
    ).rejects.toBeInstanceOf(FilePermissionError);

    const clearanceBytes = new TextEncoder().encode('%PDF-1.7 clearance');
    const clearance = await restrictedService.beginUpload({
      context: guardianContext,
      purpose: 'document',
      mime: 'application/pdf',
      bytes: clearanceBytes.byteLength,
      ownerType: 'return_to_play_clearance',
      ownerId: injuryReportId,
      sensitivity: 'restricted',
    });
    await restrictedService.uploadLocalBytes(
      guardianContext,
      clearance.fileId,
      clearanceBytes,
    );
    await restrictedService.completeUpload(guardianContext, clearance.fileId);
    await expect(
      restrictedService.download(complianceContext, clearance.fileId),
    ).resolves.toBe(`/api/v1/files/${clearance.fileId}/content`);

    await expect(
      restrictedService.download(guardianContext, pending.fileId),
    ).rejects.toBeInstanceOf(FileValidationError);
    await expect(
      restrictedService.download(adminContext, pending.fileId),
    ).rejects.toBeInstanceOf(FileValidationError);
    await expect(
      restrictedService.download(contextB, pending.fileId),
    ).rejects.toBeInstanceOf(FileValidationError);
    await expect(
      restrictedService.download(complianceContext, pending.fileId),
    ).resolves.toBe(`/api/v1/files/${pending.fileId}/content`);

    let requestContext = adminContext;
    const app = express();
    app.use(
      createFilesRouter({
        files: restrictedService,
        context: () => Promise.resolve(requestContext),
        publicFacilityLayout: () => Promise.resolve(null),
        publicSponsorLogo: () => Promise.resolve(null),
      }),
    );
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Files test server did not bind to a TCP port');
    const requestContent = async (context: OrgContext) => {
      requestContext = context;
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/${pending.fileId}/content`,
      );
      return { status: response.status, body: await response.text() };
    };
    try {
      for (const context of [
        guardianContext,
        adminContext,
        unverifiedGuardianContext,
        contextB,
      ])
        expect((await requestContent(context)).status).toBe(404);
      const permittedRead = await requestContent(complianceContext);
      expect(permittedRead).toEqual({
        status: 200,
        body: '%PDF-1.7 restricted evidence',
      });
      await expect(
        restrictedService.readLocalContent(contextA, pending.fileId),
      ).resolves.toMatchObject({ mime: 'application/pdf' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    const restrictedReads = await createWithOrg(database)(
      complianceContext,
      (trx) =>
        trx
          .selectFrom('audit_log')
          .select(['actor_account_id', 'action'])
          .where('entity_id', '=', pending.fileId)
          .where('action', '=', 'file.restricted.read')
          .execute(),
    );
    expect(restrictedReads).toHaveLength(2);
    expect(restrictedReads).toEqual(
      expect.arrayContaining([
        { actor_account_id: complianceAccount, action: 'file.restricted.read' },
        { actor_account_id: accountA, action: 'file.restricted.read' },
      ]),
    );
  });
});
