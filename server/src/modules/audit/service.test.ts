import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';

import {
  AuditAccessError,
  appendAuditEvent,
  listAuditEntries,
  withAuditedRestrictedRead,
} from './service';

const orgId = randomUUID();
const ownerId = randomUUID();
const complianceId = randomUUID();
const outsiderId = randomUUID();
const entityId = randomUUID();
let database: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const [id, name] of [
      [ownerId, 'Owner'],
      [complianceId, 'Compliance'],
      [outsiderId, 'Outsider'],
    ] as const) {
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [id, `${id}@example.invalid`, name, 'Tester', '1990-01-01'],
      );
    }
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone) VALUES ($1,$2,$3,$4,$5)',
      [orgId, `audit-${orgId.slice(0, 8)}`, 'Audit test', 'club', 'UTC'],
    );
    for (const [accountId, role] of [
      [ownerId, 'owner'],
      [complianceId, 'compliance'],
    ]) {
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
        [randomUUID(), orgId, accountId, 'active'],
      );
      await admin.query(
        'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), orgId, accountId, role, 'org'],
      );
    }
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => database.destroy());

describe('audit service', () => {
  it('records field redaction and audits Restricted reads in the read transaction', async () => {
    const runWithOrg = createWithOrg(database);
    const owner = { orgId, actor: { accountId: ownerId } };
    await runWithOrg(owner, (trx) =>
      appendAuditEvent(trx, owner, {
        action: 'update',
        entityType: 'person',
        entityId,
        changes: {
          name: { tier: 'internal', before: 'Old', after: 'New' },
          medical: {
            tier: 'restricted',
            before: 'secret',
            after: 'new secret',
          },
        },
      }).then(() => undefined),
    );
    await expect(
      withAuditedRestrictedRead(
        owner,
        'medical_profile',
        entityId,
        ['allergies'],
        () => Promise.resolve('private'),
        runWithOrg,
      ),
    ).resolves.toBe('private');
    const page = await listAuditEntries(owner, { limit: 1 }, runWithOrg);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      action: 'restricted.read',
      entityId,
      changes: { allergies: { after: '[redacted]' } },
    });
    expect(page.nextCursor).toBeTruthy();
    const next = await listAuditEntries(
      owner,
      { limit: 1, cursor: page.nextCursor ?? '' },
      runWithOrg,
    );
    expect(next.items[0]).toMatchObject({
      action: 'update',
      changes: {
        medical: { before: '[redacted]', after: '[redacted]' },
        name: { after: 'New' },
      },
    });
  });

  it('limits compliance officers to Restricted-read entries and hides history from outsiders', async () => {
    const runWithOrg = createWithOrg(database);
    const page = await listAuditEntries(
      { orgId, actor: { accountId: complianceId } },
      { limit: 50 },
      runWithOrg,
    );
    expect(
      page.items.every((entry) => entry.action === 'restricted.read'),
    ).toBe(true);
    await expect(
      listAuditEntries(
        { orgId, actor: { accountId: outsiderId } },
        { limit: 50 },
        runWithOrg,
      ),
    ).rejects.toBeInstanceOf(AuditAccessError);
  });
});
