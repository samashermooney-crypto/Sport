import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/db/kysely';
import type { DB } from '../../src/db/types';
import {
  auditImpersonatedRequest,
  endImpersonation,
  getImpersonation,
  startImpersonation,
} from '../../src/modules/platform/impersonation';
import { PlatformAccessError } from '../../src/modules/platform/service';

const now = new Date('2026-09-27T16:00:00Z');
let database: Kysely<DB>;
let accountId: string;
let orgId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_URL ?? '');
  accountId = randomUUID();
  orgId = randomUUID();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `impersonation-${accountId}@example.invalid`,
      first_name: 'Platform',
      last_name: 'Support',
      date_of_birth: '1980-01-01',
    })
    .execute();
  await database
    .insertInto('platform_staff')
    .values({ account_id: accountId, role: 'support' })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `impersonation-${accountId.slice(0, 8)}`,
      name: 'Impersonation Fixture',
      kind: 'club',
      timezone: 'UTC',
      status: 'active',
    })
    .execute();
});

afterAll(async () => {
  await database.destroy();
});

describe('platform impersonation safeguards', () => {
  it('is read-only, audited, and expires within one hour', async () => {
    const actor = { accountId, role: 'support' as const };
    const started = await startImpersonation(
      database,
      actor,
      orgId,
      'Investigate a support report',
      now,
    );
    expect(started).toMatchObject({ readOnly: true, organizationId: orgId });
    expect(new Date(started.expiresAt).getTime() - now.getTime()).toBe(
      60 * 60 * 1000,
    );
    await expect(
      getImpersonation(database, actor, started.id, now),
    ).resolves.toEqual(started);
    await auditImpersonatedRequest(
      database,
      actor,
      started.id,
      { method: 'GET', path: '/api/v1/orgs/workspace', organizationId: orgId },
      now,
    );
    await expect(
      auditImpersonatedRequest(
        database,
        actor,
        started.id,
        { method: 'POST', path: '/api/v1/people', organizationId: orgId },
        now,
      ),
    ).rejects.toBeInstanceOf(PlatformAccessError);

    await endImpersonation(database, actor, started.id, now);
    await expect(
      getImpersonation(database, actor, started.id, now),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses impersonation for finance operations staff', async () => {
    await expect(
      startImpersonation(
        database,
        { accountId, role: 'finance_ops' },
        orgId,
        'Investigate a support report',
        now,
      ),
    ).rejects.toBeInstanceOf(PlatformAccessError);
  });
});
