import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { issueSession } from '../auth/sessions';
import type { ActiveSession } from '../auth/sessions';

import {
  listFeatureFlags,
  listPlans,
  listPlatformStaff,
  saveFeatureFlag,
  savePlan,
  savePlatformStaff,
} from './admin';
import { platformHealth } from './health';
import {
  auditImpersonatedRequest,
  endImpersonation,
  getImpersonation,
  startImpersonation,
} from './impersonation';
import {
  getOrganization,
  listOrganizations,
  PlatformAccessError,
  requirePlatformStaff,
  setOrganizationPlan,
  setOrganizationStatus,
} from './service';

const orgId = randomUUID();
const adminId = randomUUID();
const supportId = randomUUID();
const userId = randomUUID();
let database: ReturnType<typeof createDatabase>;
let adminDatabase: ReturnType<typeof createDatabase>;
const platformAdmin = { accountId: adminId, role: 'super_admin' as const };
const support = { accountId: supportId, role: 'support' as const };

function session(accountId: string, mfaVerifiedAt: Date | null): ActiveSession {
  return {
    id: randomUUID(),
    accountId,
    kind: 'cookie',
    client: 'web',
    privileged: true,
    elevatedUntil: null,
    mfaVerifiedAt,
  };
}

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const id of [adminId, supportId, userId])
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [id, `${id}@example.invalid`, 'Platform', 'Tester', '1990-01-01'],
      );
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        orgId,
        `platform-${orgId.slice(0, 8)}`,
        'Platform test',
        'club',
        'UTC',
        'active',
      ],
    );
    await admin.query(
      'INSERT INTO platform_staff(account_id,role) VALUES ($1,$2),($3,$4)',
      [adminId, 'super_admin', supportId, 'support'],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  adminDatabase = createDatabase(process.env.TEST_DATABASE_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
  await adminDatabase.destroy();
});

describe('platform administration', () => {
  it('requires active staff MFA and protects the last super admin', async () => {
    await expect(
      requirePlatformStaff(database, session(adminId, null), ['super_admin']),
    ).rejects.toBeInstanceOf(PlatformAccessError);
    expect(
      await requirePlatformStaff(database, session(adminId, new Date()), [
        'super_admin',
      ]),
    ).toEqual(platformAdmin);
    await expect(
      requirePlatformStaff(database, session(userId, new Date()), [
        'super_admin',
      ]),
    ).rejects.toBeInstanceOf(PlatformAccessError);
    await expect(
      savePlatformStaff(adminDatabase, platformAdmin, adminId, {
        role: 'support',
        active: true,
      }),
    ).rejects.toThrow('last active');
    expect(
      (await listPlatformStaff(database)).map((row) => row.role),
    ).toContain('super_admin');
    await expect(
      sql`UPDATE platform_staff SET active = false WHERE account_id = ${supportId}`.execute(
        database,
      ),
    ).rejects.toThrow('permission denied');
    const issued = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: userId,
          kind: 'cookie',
          client: 'web',
          privileged: true,
          mfaVerifiedAt: new Date(),
        },
        new Date(),
      ),
    );
    await savePlatformStaff(adminDatabase, platformAdmin, userId, {
      role: 'support',
      active: true,
    });
    const revoked = await database
      .selectFrom('sessions')
      .select('revoked_at')
      .where('id', '=', issued.id)
      .executeTakeFirst();
    expect(revoked?.revoked_at).toBeInstanceOf(Date);
  });

  it('lists and suspends an organization with version checks and audit', async () => {
    expect(
      (
        await listOrganizations(database, {
          limit: 50,
          search: 'Platform test',
        })
      ).items,
    ).toMatchObject([{ id: orgId, status: 'active' }]);
    const org = await getOrganization(database, platformAdmin, orgId);
    expect(org).toMatchObject({ id: orgId, stripe: null });
    await expect(
      setOrganizationStatus(database, support, orgId, {
        status: 'suspended',
        expectedVersion: org.version,
      }),
    ).rejects.toBeInstanceOf(PlatformAccessError);
    expect(
      await setOrganizationStatus(database, platformAdmin, orgId, {
        status: 'suspended',
        expectedVersion: org.version,
      }),
    ).toMatchObject({ status: 'suspended' });
    await expect(
      setOrganizationStatus(database, platformAdmin, orgId, {
        status: 'active',
        expectedVersion: org.version,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const audits = await database
      .selectFrom('organizations')
      .select('status')
      .where('id', '=', orgId)
      .executeTakeFirst();
    expect(audits?.status).toBe('suspended');
  });

  it('saves feature flags and enforces read-only expiring impersonation', async () => {
    expect(
      await saveFeatureFlag(adminDatabase, platformAdmin, 'test.feature', {
        description: 'Test feature',
        enabled: false,
        organizationOverrides: {},
        expectedVersion: 0,
      }),
    ).toEqual({ key: 'test.feature', version: 1 });
    expect((await listFeatureFlags(database))[0]).toMatchObject({
      key: 'test.feature',
      enabled: false,
    });
    await expect(
      saveFeatureFlag(adminDatabase, platformAdmin, 'test.feature', {
        description: 'Test feature',
        enabled: true,
        organizationOverrides: { [randomUUID()]: true },
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(PlatformAccessError);
    const now = new Date();
    const current = await startImpersonation(
      adminDatabase,
      support,
      orgId,
      'Investigate a reported issue',
      now,
    );
    expect(current.readOnly).toBe(true);
    expect(new Date(current.expiresAt).getTime() - now.getTime()).toBe(
      3_600_000,
    );
    await expect(
      auditImpersonatedRequest(
        database,
        support,
        current.id,
        { method: 'POST', path: '/api/v1/orgs', organizationId: orgId },
        now,
      ),
    ).rejects.toBeInstanceOf(PlatformAccessError);
    await auditImpersonatedRequest(
      database,
      support,
      current.id,
      { method: 'GET', path: '/api/v1/orgs', organizationId: orgId },
      now,
    );
    const audit = await sql<{
      action: string;
    }>`SELECT action FROM platform_audit_log
      WHERE impersonation_id = ${current.id} ORDER BY created_at`.execute(
      database,
    );
    expect(audit.rows.map((row) => row.action)).toContain(
      'impersonation.request',
    );
    await expect(
      getImpersonation(
        database,
        support,
        current.id,
        new Date(now.getTime() + 3_600_001),
      ),
    ).rejects.toBeInstanceOf(PlatformAccessError);
    await endImpersonation(adminDatabase, support, current.id, now);
    await expect(
      getImpersonation(database, support, current.id, now),
    ).rejects.toBeInstanceOf(PlatformAccessError);
  });

  it('creates a versioned plan and assigns it to an organization', async () => {
    const saved = await savePlan(adminDatabase, platformAdmin, null, {
      key: `test-${orgId.slice(0, 8)}`,
      name: 'Test plan',
      monthlyPriceCents: 1200,
      applicationFeeBps: 150,
      applicationFeeFixedCents: 25,
      limits: { teams: 20 },
      active: true,
      expectedVersion: 0,
    });
    expect(
      (await listPlans(database)).some((plan) => plan.id === saved.id),
    ).toBe(true);
    const org = await getOrganization(database, platformAdmin, orgId);
    expect(
      await setOrganizationPlan(database, platformAdmin, orgId, {
        planId: saved.id,
        expectedVersion: org.version,
      }),
    ).toMatchObject({ planId: saved.id, version: org.version + 1 });
    expect(
      (await getOrganization(database, platformAdmin, orgId)).planName,
    ).toBe('Test plan');
  });

  it('reports queue, worker and webhook health without job payloads', async () => {
    expect(await platformHealth(database)).toMatchObject({
      queues: [],
      workerHeartbeatAt: null,
      lastStripeWebhookReceivedAt: null,
    });
  });
});
