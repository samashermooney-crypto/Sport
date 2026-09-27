import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';

import { OrgMemberRolesError, setOrgMemberRoles } from './memberRoles';

const orgId = randomUUID();
const firstOwnerId = randomUUID();
const owners = [firstOwnerId, randomUUID()];
const now = new Date('2026-09-27T12:00:00Z');
let database: Kysely<DB>;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const accountId of owners) {
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [
          accountId,
          `${accountId}@example.invalid`,
          'Org',
          'Owner',
          '1980-01-01',
        ],
      );
    }
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        orgId,
        `owner-race-${orgId.slice(0, 8)}`,
        'Owner race',
        'club',
        'UTC',
        'active',
      ],
    );
    for (const accountId of owners) {
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
        [randomUUID(), orgId, accountId, 'active'],
      );
      for (const role of ['owner', 'admin']) {
        await admin.query(
          'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,$4,$5,false)',
          [randomUUID(), orgId, accountId, role, 'org'],
        );
      }
    }
  } finally {
    await admin.end();
  }
});

afterAll(async () => database.destroy());

describe('concurrent owner demotion', () => {
  it('serializes two demotions and keeps one active owner', async () => {
    const results = await Promise.allSettled(
      owners.map((accountId) =>
        setOrgMemberRoles(database, {
          orgId,
          actorId: accountId,
          targetId: accountId,
          changes: { roles: ['admin'], expectedVersion: 1 },
          now,
        }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(OrgMemberRolesError);
    expect(rejected?.reason).toMatchObject({ status: 409, code: 'CONFLICT' });
    const remaining = await createWithOrg(database)(
      { orgId, actor: { accountId: firstOwnerId } },
      (trx) =>
        trx
          .selectFrom('role_assignments')
          .innerJoin('org_memberships', (join) =>
            join
              .onRef('org_memberships.org_id', '=', 'role_assignments.org_id')
              .onRef(
                'org_memberships.account_id',
                '=',
                'role_assignments.account_id',
              ),
          )
          .select('role_assignments.account_id')
          .where('role_assignments.org_id', '=', orgId)
          .where('role_assignments.role', '=', 'owner')
          .where('role_assignments.revoked_at', 'is', null)
          .where('org_memberships.status', '=', 'active')
          .execute(),
    );
    expect(remaining).toHaveLength(1);
  });
});
