import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { MemoryStorage } from '../../integrations/storage/storage';
import type { Storage } from '../../integrations/storage/storage';
import { encryptRestricted, parseEncryptionKeys } from '../../lib/crypto';

import {
  buildOrganizationExport,
  createOrganizationExportDownloadLink,
  createOrganizationPrivacyRequest,
  createPrivacySubjectExport,
  downloadOrganizationExport,
  listOrganizationExports,
  OrganizationExportError,
  requestOrganizationExport,
  runRetentionSweepJob,
  updateOrganizationPrivacyRequest,
} from './service';

const orgId = randomUUID();
const ownerId = randomUUID();
const financeId = randomUUID();
const personId = randomUUID();
const retentionSystemActorId = '0199a1c0-0000-7000-8000-000000000001';
const encryption = parseEncryptionKeys(
  JSON.stringify({ test: Buffer.alloc(32, 7).toString('base64') }),
  'test',
);
let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;

function unzipTextEntries(archive: Uint8Array): Map<string, string> {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const decoder = new TextDecoder();
  const entries = new Map<string, string>();
  let offset = 0;
  while (
    offset + 30 <= archive.length &&
    view.getUint32(offset, true) === 0x04034b50
  ) {
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(
      archive.subarray(nameStart, nameStart + nameLength),
    );
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const contents =
      method === 8
        ? inflateRawSync(compressed)
        : method === 0
          ? Buffer.from(compressed)
          : (() => {
              throw new Error(
                `Unsupported ZIP compression method ${String(method)}`,
              );
            })();
    entries.set(name, contents.toString('utf8'));
    offset = dataStart + compressedSize;
  }
  return entries;
}

const context = (accountId: string): OrgContext => ({
  orgId,
  actor: { accountId },
});

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const [id, name] of [
      [ownerId, 'Export Owner'],
      [financeId, 'Export Finance'],
    ] as const) {
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [id, `${id}@example.invalid`, name, 'Tester', '1980-01-01'],
      );
    }
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        orgId,
        `exports-${orgId.slice(0, 8)}`,
        'Exports Test',
        'club',
        'UTC',
        'active',
      ],
    );
    for (const [accountId, role] of [
      [ownerId, 'owner'],
      [financeId, 'finance'],
    ] as const) {
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
        [randomUUID(), orgId, accountId, 'active'],
      );
      await admin.query(
        'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,$4,$5,false)',
        [randomUUID(), orgId, accountId, role, 'org'],
      );
    }
    await admin.query(
      'INSERT INTO people(id,org_id,first_name,last_name,date_of_birth,email) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        personId,
        orgId,
        '=HYPERLINK("https://example.invalid")',
        'Athlete',
        '2012-01-01',
        'athlete@example.invalid',
      ],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

describe('organization data export', () => {
  it('requires step-up and restricts archive requests to owners and admins', async () => {
    await expect(
      requestOrganizationExport(
        context(ownerId),
        false,
        () => Promise.resolve('job'),
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 401, code: 'REAUTH_REQUIRED' });
    await expect(
      requestOrganizationExport(
        context(financeId),
        true,
        () => Promise.resolve('job'),
        withOrg,
      ),
    ).rejects.toBeInstanceOf(OrganizationExportError);
  });

  it('builds a CSV archive and serves it only through an expiring hashed link', async () => {
    const queued: string[][] = [];
    const requested = await requestOrganizationExport(
      context(ownerId),
      true,
      (requestedOrgId, exportId) => {
        queued.push([requestedOrgId, exportId]);
        return Promise.resolve();
      },
      withOrg,
    );
    expect(queued).toEqual([[orgId, requested.export.id]]);

    const storage = new MemoryStorage();
    const now = new Date('2026-09-27T18:00:00.000Z');
    await expect(
      buildOrganizationExport(
        orgId,
        requested.export.id,
        database,
        storage,
        now,
      ),
    ).resolves.toMatchObject({ status: 'ready' });
    const listed = await listOrganizationExports(context(ownerId), withOrg);
    expect(listed.items[0]).toMatchObject({
      id: requested.export.id,
      status: 'ready',
    });

    const link = await createOrganizationExportDownloadLink(
      context(ownerId),
      requested.export.id,
      true,
      'https://athlentry.example.test',
      now,
      withOrg,
    );
    expect(new Date(link.expiresAt).getTime() - now.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    const token = new URL(link.url).pathname.split('/').at(-1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const archive = await downloadOrganizationExport(
      token ?? '',
      database,
      storage,
      now,
    );
    expect(archive.byteLength).toBeGreaterThan(100);
    const entries = unzipTextEntries(archive);
    expect(entries.has('manifest.json')).toBe(true);
    expect(entries.has('files/manifest.csv')).toBe(true);
    expect(entries.has('tables/people.csv')).toBe(true);
    expect(entries.get('tables/people.csv')).toContain("'=HYPERLINK");
    const manifest = JSON.parse(entries.get('manifest.json') ?? '{}') as {
      files?: number;
      tables?: Record<string, number>;
    };
    expect(manifest.tables?.people).toBeGreaterThan(0);
    expect(manifest.files).toBe(0);
    await expect(
      downloadOrganizationExport('A'.repeat(43), database, storage, now),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('deletes expired organization archives and preserves live downloads during retention', async () => {
    const storage = new MemoryStorage();
    const expiredAt = new Date('2026-09-01T18:00:00.000Z');
    const liveAt = new Date('2026-09-10T08:00:00.000Z');
    const sweepAt = new Date('2026-09-10T18:00:00.000Z');
    const expiredRequest = await requestOrganizationExport(
      context(ownerId),
      true,
      () => Promise.resolve(),
      withOrg,
    );
    const liveRequest = await requestOrganizationExport(
      context(ownerId),
      true,
      () => Promise.resolve(),
      withOrg,
    );
    await buildOrganizationExport(
      orgId,
      expiredRequest.export.id,
      database,
      storage,
      expiredAt,
    );
    await buildOrganizationExport(
      orgId,
      liveRequest.export.id,
      database,
      storage,
      liveAt,
    );
    const expiredLink = await createOrganizationExportDownloadLink(
      context(ownerId),
      expiredRequest.export.id,
      true,
      'https://athlentry.example.test',
      expiredAt,
      withOrg,
    );
    const liveLink = await createOrganizationExportDownloadLink(
      context(ownerId),
      liveRequest.export.id,
      true,
      'https://athlentry.example.test',
      liveAt,
      withOrg,
    );
    const tokenFromLink = (url: string) =>
      new URL(url).pathname.split('/').at(-1) ?? '';
    const before = await withOrg(context(ownerId), async (trx) =>
      trx
        .selectFrom('org_data_exports')
        .innerJoin('files', (join) =>
          join
            .onRef('files.org_id', '=', 'org_data_exports.org_id')
            .onRef('files.id', '=', 'org_data_exports.file_id'),
        )
        .select([
          'org_data_exports.id as export_id',
          'files.storage_key as storage_key',
        ])
        .where('org_data_exports.org_id', '=', orgId)
        .where('org_data_exports.id', 'in', [
          expiredRequest.export.id,
          liveRequest.export.id,
        ])
        .execute(),
    );
    const expiredStorageKey = before.find(
      (row) => row.export_id === expiredRequest.export.id,
    )?.storage_key;
    const liveStorageKey = before.find(
      (row) => row.export_id === liveRequest.export.id,
    )?.storage_key;
    expect(expiredStorageKey).toBeTruthy();
    expect(liveStorageKey).toBeTruthy();
    expect(await storage.get(expiredStorageKey ?? '')).not.toBeNull();
    expect(await storage.get(liveStorageKey ?? '')).not.toBeNull();

    const flakyStorage: Storage = {
      put: (key, bytes, contentType) => storage.put(key, bytes, contentType),
      get: (key) => storage.get(key),
      delete: (key) =>
        key === expiredStorageKey
          ? Promise.reject(new Error('temporary storage failure'))
          : storage.delete(key),
      presignPut: (key, contentType, maxBytes, expiresSeconds) =>
        storage.presignPut(key, contentType, maxBytes, expiresSeconds),
      presignGet: (key, expiresSeconds, downloadName) =>
        storage.presignGet(key, expiresSeconds, downloadName),
    };
    const firstSweep = await runRetentionSweepJob(
      {},
      sweepAt,
      database,
      withOrg,
      flakyStorage,
    );

    expect(firstSweep.summaries[0]?.counts).toMatchObject({
      organizationExportsExpired: 1,
      organizationExportObjectsDeleted: 0,
      organizationExportCleanupPending: 1,
    });
    expect(await storage.get(expiredStorageKey ?? '')).not.toBeNull();
    await expect(
      downloadOrganizationExport(
        tokenFromLink(expiredLink.url),
        database,
        storage,
        sweepAt,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      downloadOrganizationExport(
        tokenFromLink(liveLink.url),
        database,
        storage,
        sweepAt,
      ),
    ).resolves.toBeInstanceOf(Uint8Array);

    const retry = await runRetentionSweepJob(
      {},
      sweepAt,
      database,
      withOrg,
      storage,
    );
    expect(retry.summaries[0]?.counts).toMatchObject({
      organizationExportsExpired: 0,
      organizationExportObjectsDeleted: 1,
      organizationExportCleanupPending: 0,
    });
    expect(await storage.get(expiredStorageKey ?? '')).toBeNull();
    expect(await storage.get(liveStorageKey ?? '')).not.toBeNull();

    const retired = await withOrg(context(ownerId), async (trx) =>
      trx
        .selectFrom('org_data_exports')
        .innerJoin('files', (join) =>
          join
            .onRef('files.org_id', '=', 'org_data_exports.org_id')
            .onRef('files.id', '=', 'org_data_exports.file_id'),
        )
        .select([
          'org_data_exports.id as export_id',
          'org_data_exports.status as status',
          'files.deleted_at as deleted_at',
        ])
        .where('org_data_exports.org_id', '=', orgId)
        .where('org_data_exports.id', 'in', [
          expiredRequest.export.id,
          liveRequest.export.id,
        ])
        .execute(),
    );
    const expiredMetadata = retired.find(
      (row) => row.export_id === expiredRequest.export.id,
    );
    expect(expiredMetadata?.status).toBe('expired');
    expect(expiredMetadata?.deleted_at).toBeInstanceOf(Date);
    const liveMetadata = retired.find(
      (row) => row.export_id === liveRequest.export.id,
    );
    expect(liveMetadata?.status).toBe('ready');
    expect(liveMetadata?.deleted_at).toBeNull();
  });

  it('exports a subject data bundle with restricted fields decrypted and audited', async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const formDefinitionId = randomUUID();
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO form_definitions(id,org_id,scope,name,schema)
         VALUES ($1,$2,'person_profile','Access export form','{"type":"object"}'::jsonb)`,
        [formDefinitionId, orgId],
      );
      await admin.query(
        `INSERT INTO form_responses(id,org_id,form_definition_id,definition_version,subject_type,subject_id,answers,answers_enc,submitted_by_account_id)
         VALUES ($1,$2,$3,1,'person',$4,'{"name":"Athlete"}'::jsonb,$5,$6)`,
        [
          randomUUID(),
          orgId,
          formDefinitionId,
          personId,
          encryptRestricted(
            Buffer.from(JSON.stringify({ allergy: 'peanut' })),
            encryption,
          ),
          ownerId,
        ],
      );
      await admin.query(
        `INSERT INTO medical_profiles(id,org_id,person_id,allergies_enc,allergy_flags,notes_enc)
         VALUES ($1,$2,$3,$4,ARRAY['peanut'],$5)`,
        [
          randomUUID(),
          orgId,
          personId,
          encryptRestricted(Buffer.from('peanut allergy'), encryption),
          encryptRestricted(Buffer.from('carry inhaler'), encryption),
        ],
      );
    } finally {
      await admin.end();
    }

    const created = await createOrganizationPrivacyRequest(
      context(ownerId),
      { kind: 'access', subjectType: 'person', subjectId: personId },
      true,
      withOrg,
    );
    const inReview = await updateOrganizationPrivacyRequest(
      context(ownerId),
      created.id,
      { status: 'in_review', version: created.version },
      true,
      new Date('2026-09-27T18:00:00.000Z'),
      withOrg,
    );
    const approved = await updateOrganizationPrivacyRequest(
      context(ownerId),
      created.id,
      { status: 'approved', version: inReview.version },
      true,
      new Date('2026-09-27T18:01:00.000Z'),
      withOrg,
    );
    await expect(
      createPrivacySubjectExport(
        context(ownerId),
        created.id,
        true,
        new Date('2026-09-27T18:02:00.000Z'),
        withOrg,
        encryption,
      ),
    ).resolves.toMatchObject({
      requestId: created.id,
      data: {
        medicalProfiles: [
          expect.objectContaining({
            allergies: 'peanut allergy',
            notes: 'carry inhaler',
          }),
        ],
      },
    });
    expect(approved.status).toBe('approved');
    const exports = await createPrivacySubjectExport(
      context(ownerId),
      created.id,
      true,
      new Date('2026-09-27T18:02:00.000Z'),
      withOrg,
      encryption,
    );
    expect(exports.data.formResponses).toEqual([
      expect.objectContaining({
        answers: { name: 'Athlete' },
        restrictedAnswers: { allergy: 'peanut' },
      }),
    ]);
    const auditedReads = await withOrg(context(ownerId), (trx) =>
      trx
        .selectFrom('audit_log')
        .select(['entity_type', 'entity_id'])
        .where('org_id', '=', orgId)
        .where('action', '=', 'restricted.read')
        .where('entity_type', 'in', ['medical_profile', 'form_response'])
        .execute(),
    );
    expect(auditedReads.map(({ entity_type }) => entity_type)).toEqual(
      expect.arrayContaining(['medical_profile', 'form_response']),
    );
  });

  it('deletion anonymizes a person while retaining invoices and waiver evidence', async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const deletionPersonId = randomUUID();
    const photoFileId = randomUUID();
    const householdId = randomUUID();
    const formDefinitionId = randomUUID();
    const waiverDocumentId = randomUUID();
    const invoiceId = randomUUID();
    const waiverId = randomUUID();
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO people(id,org_id,first_name,last_name,date_of_birth,email,phone_e164,address)
         VALUES ($1,$2,'Private','Athlete','2010-04-03','private@example.invalid','+13125550123','{"city":"Chicago"}'::jsonb)`,
        [deletionPersonId, orgId],
      );
      await admin.query(
        `INSERT INTO files(id,org_id,purpose,owner_type,owner_id,storage_key,mime,bytes,sensitivity,created_by,upload_state,expires_at)
         VALUES ($1,$2,'image','person',$3,$4,'image/png',512,'sensitive',$5,'complete',now()+interval '1 day')`,
        [
          photoFileId,
          orgId,
          deletionPersonId,
          `privacy-test/${photoFileId}.png`,
          ownerId,
        ],
      );
      await admin.query(
        'UPDATE people SET photo_file_id = $1 WHERE org_id = $2 AND id = $3',
        [photoFileId, orgId, deletionPersonId],
      );
      await admin.query(
        `INSERT INTO person_account_links(id,org_id,person_id,account_id,relationship,verified_at)
         VALUES ($1,$2,$3,$4,'self',now())`,
        [randomUUID(), orgId, deletionPersonId, ownerId],
      );
      await admin.query(
        `INSERT INTO households(id,org_id,name,address) VALUES ($1,$2,'Private Family','{"city":"Chicago"}'::jsonb)`,
        [householdId, orgId],
      );
      await admin.query(
        `INSERT INTO household_members(id,org_id,household_id,person_id,role,financially_responsible)
         VALUES ($1,$2,$3,$4,'athlete',true)`,
        [randomUUID(), orgId, householdId, deletionPersonId],
      );
      await admin.query(
        `INSERT INTO emergency_contacts(id,org_id,person_id,name,relationship,phone_e164,priority)
         VALUES ($1,$2,$3,'Private Contact','parent','+13125550124',1)`,
        [randomUUID(), orgId, deletionPersonId],
      );
      await admin.query(
        `INSERT INTO medical_profiles(id,org_id,person_id,allergies_enc,allergy_flags)
         VALUES ($1,$2,$3,$4,ARRAY['peanut'])`,
        [
          randomUUID(),
          orgId,
          deletionPersonId,
          encryptRestricted(Buffer.from('peanut allergy'), encryption),
        ],
      );
      await admin.query(
        `INSERT INTO form_definitions(id,org_id,scope,name,schema)
         VALUES ($1,$2,'person_profile','Deletion form','{"type":"object"}'::jsonb)`,
        [formDefinitionId, orgId],
      );
      await admin.query(
        `INSERT INTO form_responses(id,org_id,form_definition_id,definition_version,subject_type,subject_id,answers,answers_enc,submitted_by_account_id)
         VALUES ($1,$2,$3,1,'person',$4,'{"email":"private@example.invalid"}'::jsonb,$5,$6)`,
        [
          randomUUID(),
          orgId,
          formDefinitionId,
          deletionPersonId,
          Buffer.from('restricted'),
          ownerId,
        ],
      );
      await admin.query(
        `INSERT INTO waiver_documents(id,org_id,name,body_html,requires,renewal,published_at)
         VALUES ($1,$2,'Retention waiver','Waiver text','participant','once',now())`,
        [waiverDocumentId, orgId],
      );
      await admin.query(
        `INSERT INTO waiver_signatures(id,org_id,waiver_document_id,document_version,document_hash,participant_person_id,signer_account_id,signer_name_typed,method)
         VALUES ($1,$2,$3,1,$4,$5,$6,'Private Athlete','online_typed')`,
        [
          waiverId,
          orgId,
          waiverDocumentId,
          Buffer.alloc(32, 2),
          deletionPersonId,
          ownerId,
        ],
      );
      await admin.query(
        `INSERT INTO invoices(id,org_id,number,account_id,household_id,status,source)
         VALUES ($1,$2,90123,$3,$4,'open','staff')`,
        [invoiceId, orgId, ownerId, householdId],
      );
    } finally {
      await admin.end();
    }

    const created = await createOrganizationPrivacyRequest(
      context(ownerId),
      { kind: 'deletion', subjectType: 'person', subjectId: deletionPersonId },
      true,
      withOrg,
    );
    const inReview = await updateOrganizationPrivacyRequest(
      context(ownerId),
      created.id,
      { status: 'in_review', version: created.version },
      true,
      new Date('2026-09-27T18:00:00.000Z'),
      withOrg,
    );
    const approved = await updateOrganizationPrivacyRequest(
      context(ownerId),
      created.id,
      { status: 'approved', version: inReview.version },
      true,
      new Date('2026-09-27T18:01:00.000Z'),
      withOrg,
    );
    await updateOrganizationPrivacyRequest(
      context(ownerId),
      created.id,
      {
        status: 'completed',
        version: approved.version,
        resolutionNote: 'Data anonymized; legal records retained.',
      },
      true,
      new Date('2026-09-27T18:02:00.000Z'),
      withOrg,
    );

    const result = await withOrg(context(ownerId), async (trx) => ({
      person: await trx
        .selectFrom('people')
        .select([
          'first_name',
          'last_name',
          'email',
          'phone_e164',
          'photo_file_id',
          'status',
        ])
        .where('org_id', '=', orgId)
        .where('id', '=', deletionPersonId)
        .executeTakeFirstOrThrow(),
      photoFile: await trx
        .selectFrom('files')
        .select('deleted_at')
        .where('org_id', '=', orgId)
        .where('id', '=', photoFileId)
        .executeTakeFirstOrThrow(),
      household: await trx
        .selectFrom('households')
        .select(['name', 'address', 'status'])
        .where('org_id', '=', orgId)
        .where('id', '=', householdId)
        .executeTakeFirstOrThrow(),
      invoice: await trx
        .selectFrom('invoices')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', '=', invoiceId)
        .executeTakeFirst(),
      waiver: await trx
        .selectFrom('waiver_signatures')
        .select(['id', 'participant_person_id'])
        .where('org_id', '=', orgId)
        .where('id', '=', waiverId)
        .executeTakeFirst(),
      response: await trx
        .selectFrom('form_responses')
        .select(['answers', 'answers_enc'])
        .where('org_id', '=', orgId)
        .where('subject_id', '=', deletionPersonId)
        .executeTakeFirstOrThrow(),
      medical: await trx
        .selectFrom('medical_profiles')
        .select(['allergies_enc', 'allergy_flags'])
        .where('org_id', '=', orgId)
        .where('person_id', '=', deletionPersonId)
        .executeTakeFirstOrThrow(),
      notice: await trx
        .selectFrom('notifications')
        .select(['type', 'payload'])
        .where('org_id', '=', orgId)
        .where('account_id', '=', ownerId)
        .where('type', '=', 'privacy_request.updated')
        .executeTakeFirst(),
      audit: await trx
        .selectFrom('audit_log')
        .select('id')
        .where('org_id', '=', orgId)
        .where('action', '=', 'privacy.request.status_changed')
        .where('entity_id', '=', created.id)
        .executeTakeFirst(),
    }));
    expect(result.person).toMatchObject({
      first_name: 'Deleted',
      last_name: 'Person',
      email: null,
      phone_e164: null,
      photo_file_id: null,
      status: 'anonymized',
    });
    expect(result.photoFile.deleted_at).toBeInstanceOf(Date);
    expect(result.household).toMatchObject({
      name: 'Deleted Household',
      address: null,
      status: 'archived',
    });
    expect(result.invoice?.id).toBe(invoiceId);
    expect(result.waiver).toEqual({
      id: waiverId,
      participant_person_id: deletionPersonId,
    });
    expect(result.response).toMatchObject({ answers: {}, answers_enc: null });
    expect(result.medical).toMatchObject({
      allergies_enc: null,
      allergy_flags: [],
    });
    expect(result.notice?.type).toBe('privacy_request.updated');
    expect(result.audit).toBeDefined();
  });

  it('sweeps aged message and background details through the weekly retention job', async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const sweepPersonId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const backgroundOrderId = randomUUID();
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO accounts(id,email,first_name,last_name,date_of_birth)
         VALUES ($1,'retention-system@example.invalid','System','Actor','1980-01-01')
         ON CONFLICT (id) DO NOTHING`,
        [retentionSystemActorId],
      );
      await admin.query(
        `INSERT INTO people(id,org_id,first_name,last_name,date_of_birth)
         VALUES ($1,$2,'Retention','Subject','2000-01-01')`,
        [sweepPersonId, orgId],
      );
      await admin.query(
        `INSERT INTO conversations(id,org_id,kind,title,created_by)
         VALUES ($1,$2,'group','Retention test',$3)`,
        [conversationId, orgId, ownerId],
      );
      await admin.query(
        `INSERT INTO chat_messages(id,org_id,conversation_id,author_account_id,body,attachments,created_at)
         VALUES ($1,$2,$3,$4,'Private message','["private-file"]'::jsonb,'2019-01-01')`,
        [messageId, orgId, conversationId, ownerId],
      );
      await admin.query(
        `INSERT INTO background_check_orders(id,org_id,person_id,provider,package,status,consent_signed_at,completed_at,details_enc,provider_candidate_id,provider_report_id)
         VALUES ($1,$2,$3,'manual','standard','clear','2020-01-01','2020-01-02',$4,'candidate-private','report-private')`,
        [
          backgroundOrderId,
          orgId,
          sweepPersonId,
          Buffer.from('private-report'),
        ],
      );
    } finally {
      await admin.end();
    }

    const result = await runRetentionSweepJob(
      {},
      new Date('2026-09-27T18:00:00.000Z'),
      database,
      withOrg,
    );
    expect(result).toMatchObject({
      completedOrganizations: 1,
      summaries: [
        {
          orgId,
          counts: {
            chatMessagesRedacted: 1,
            backgroundCheckDetailsPurged: 1,
          },
        },
      ],
    });
    const cleaned = await withOrg(context(ownerId), async (trx) => ({
      message: await trx
        .selectFrom('chat_messages')
        .select(['body', 'attachments'])
        .where('org_id', '=', orgId)
        .where('id', '=', messageId)
        .executeTakeFirstOrThrow(),
      check: await trx
        .selectFrom('background_check_orders')
        .select([
          'status',
          'details_enc',
          'provider_candidate_id',
          'provider_report_id',
        ])
        .where('org_id', '=', orgId)
        .where('id', '=', backgroundOrderId)
        .executeTakeFirstOrThrow(),
      run: await trx
        .selectFrom('retention_sweep_runs')
        .select(['finished_at', 'summary'])
        .where('org_id', '=', orgId)
        .orderBy('started_at', 'desc')
        .executeTakeFirstOrThrow(),
    }));
    expect(cleaned.message).toEqual({
      body: '[Message retained under policy]',
      attachments: [],
    });
    expect(cleaned.check).toMatchObject({
      status: 'clear',
      details_enc: null,
      provider_candidate_id: null,
      provider_report_id: null,
    });
    expect(cleaned.run.finished_at).toBeInstanceOf(Date);
  });
});
