import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { MemoryStorage } from '../../integrations/storage/storage';

import {
  buildOrganizationExport,
  createOrganizationExportDownloadLink,
  downloadOrganizationExport,
  listOrganizationExports,
  OrganizationExportError,
  requestOrganizationExport,
} from './service';

const orgId = randomUUID();
const ownerId = randomUUID();
const financeId = randomUUID();
const personId = randomUUID();
let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;

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
    await expect(
      downloadOrganizationExport('A'.repeat(43), database, storage, now),
    ).rejects.toMatchObject({ status: 404 });
  });
});
