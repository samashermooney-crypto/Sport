import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import { getDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { getPlatformAdminDatabase } from '../platform/admin';

export const systemWorkerActorId = '0199a1c0-0000-7000-8000-000000000001';

type ExpiryResult = { reminded: number; expired: number; demoted: number };

export async function processCredentialExpiryForOrganizations(
  organizationIds: readonly string[],
  processOrg: (orgId: string, actorId: string) => Promise<ExpiryResult>,
): Promise<ExpiryResult> {
  const totals = { reminded: 0, expired: 0, demoted: 0 };
  for (const orgId of organizationIds) {
    const result = await processOrg(orgId, systemWorkerActorId);
    totals.reminded += result.reminded;
    totals.expired += result.expired;
    totals.demoted += result.demoted;
  }
  return totals;
}

export async function runCredentialExpiry(): Promise<ExpiryResult> {
  const admin = getPlatformAdminDatabase();
  const database: Kysely<DB> = getDatabase();
  const organizations = await sql<{ id: string }>`SELECT id FROM organizations
    WHERE status = 'active' ORDER BY id`.execute(admin);
  const moduleName = '../compliance/service';
  const service = (await import(moduleName)) as {
    processCredentialExpiry: (
      dependencies: { database: Kysely<DB>; clock: () => Date },
      context: { orgId: string; actor: { accountId: string } },
    ) => Promise<ExpiryResult>;
  };
  if (typeof service.processCredentialExpiry !== 'function')
    throw new TypeError('Compliance expiry handler is unavailable');
  return processCredentialExpiryForOrganizations(
    organizations.rows.map((row) => row.id),
    (orgId, actorId) =>
      service.processCredentialExpiry(
        { database, clock: () => new Date() },
        { orgId, actor: { accountId: actorId } },
      ),
  );
}
