import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import express from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import { tenantGuard, requestImpersonation } from '../src/lib/tenant-guard';
import type { AuthDependencies } from '../src/modules/auth/routes';

import { createTestFactories } from './factories';

const now = new Date('2026-09-26T18:00:00Z');
const token = randomBytes(32).toString('base64url');
let database: ReturnType<typeof createDatabase>;
let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let orgId = '';
let otherOrgId = '';
let staffId = '';
let impersonationId = '';

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const factory = createTestFactories(database);
  const target = await factory.actor();
  orgId = target.orgId;
  const staff = await factory.actor();
  staffId = staff.accountId;
  otherOrgId = staff.orgId;
  impersonationId = randomUUID();
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO platform_staff(account_id, role) VALUES ($1, $2)',
      [staffId, 'support'],
    );
    await admin.query(
      `INSERT INTO sessions(id, token_hash, account_id, kind, client, privileged,
        mfa_verified_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, 'cookie', 'web', true, $4, $5, $6)`,
      [
        randomUUID(),
        createHash('sha256').update(token).digest(),
        staffId,
        now,
        new Date(now.getTime() + 60 * 60_000),
        new Date(now.getTime() + 24 * 60 * 60_000),
      ],
    );
    await admin.query(
      `INSERT INTO platform_impersonations(id, staff_account_id, target_organization_id,
       reason, started_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        impersonationId,
        staffId,
        orgId,
        'Investigating a support request',
        now,
        new Date(now.getTime() + 60 * 60_000),
      ],
    );
  } finally {
    await admin.end();
  }
  const app = express();
  app.use(
    '/api/v1',
    tenantGuard({ database, clock: () => now } as AuthDependencies),
  );
  app.get('/api/v1/orgs/:orgId/read', (request, response) => {
    response.json({
      impersonationId: requestImpersonation(request)?.id ?? null,
    });
  });
  app.post('/api/v1/orgs/:orgId/write', (_request, response) => {
    response.json({ wrote: true });
  });
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}/api/v1/orgs`;
});

afterAll(async () => {
  server.close();
  await database.destroy();
});

function guarded(
  path: string,
  method = 'GET',
  id = impersonationId,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: `__Host-athlentry_session=${token}`,
      'X-Athlentry-Impersonation': id,
    },
  });
}

describe('tenant impersonation boundary', () => {
  it('audits read-only requests in both ledgers and rejects wrong scope and writes', async () => {
    const read = await guarded(`/${orgId}/read`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ impersonationId });
    expect((await guarded(`/${orgId}/write`, 'POST')).status).toBe(403);
    expect((await guarded(`/${otherOrgId}/read`)).status).toBe(404);
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      const tenantAudit = await admin.query<{ impersonation_id: string }>(
        `SELECT impersonation_id FROM audit_log WHERE org_id = $1 AND action = 'platform.impersonation_read'`,
        [orgId],
      );
      expect(tenantAudit.rows).toEqual([{ impersonation_id: impersonationId }]);
      const platformAudit = await admin.query<{ impersonation_id: string }>(
        `SELECT impersonation_id FROM platform_audit_log WHERE action = 'impersonation.request' AND impersonation_id = $1`,
        [impersonationId],
      );
      expect(platformAudit.rows).toHaveLength(1);
    } finally {
      await admin.end();
    }
  });
  it('rejects expired impersonation and suspended organization access', async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query('UPDATE organizations SET status = $1 WHERE id = $2', [
        'suspended',
        orgId,
      ]);
      expect((await guarded(`/${orgId}/read`)).status).toBe(403);
      await admin.query('UPDATE organizations SET status = $1 WHERE id = $2', [
        'active',
        orgId,
      ]);
      await admin.query(
        'UPDATE platform_impersonations SET started_at = $1, expires_at = $2 WHERE id = $3',
        [
          new Date(now.getTime() - 2 * 60 * 60_000),
          new Date(now.getTime() - 60 * 60_000),
          impersonationId,
        ],
      );
      expect((await guarded(`/${orgId}/read`)).status).toBe(404);
    } finally {
      await admin.query('UPDATE organizations SET status = $1 WHERE id = $2', [
        'active',
        orgId,
      ]);
      await admin.end();
    }
  });
});
