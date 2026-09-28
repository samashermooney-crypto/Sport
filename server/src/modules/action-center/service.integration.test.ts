import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { loadActionCenter } from './service';

const orgId = randomUUID();
const ownerId = randomUUID();
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
    await admin.query(
      'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
      [ownerId, `${ownerId}@example.invalid`, 'Action', 'Owner', '1980-01-01'],
    );
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        orgId,
        `actions-${orgId.slice(0, 8)}`,
        'Action Center Test',
        'club',
        'UTC',
        'active',
      ],
    );
    await admin.query(
      'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
      [randomUUID(), orgId, ownerId, 'active'],
    );
    await admin.query(
      'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,$4,$5,false)',
      [randomUUID(), orgId, ownerId, 'owner', 'org'],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

describe('action center', () => {
  it('queries every role-visible source and omits empty queues', async () => {
    await expect(
      loadActionCenter(
        context(ownerId),
        withOrg,
        new Date('2026-09-28T12:00:00Z'),
      ),
    ).resolves.toEqual({ cards: [] });
  });

  it('conceals organization queues from accounts without active membership', async () => {
    await expect(
      loadActionCenter(
        context(randomUUID()),
        withOrg,
        new Date('2026-09-28T12:00:00Z'),
      ),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
