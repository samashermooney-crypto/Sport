import { sql } from 'kysely';

import { getDatabase } from '../../db/kysely';
import { getPlatformAdminDatabase } from '../platform/admin';

import { processExpiredOffers } from './service';

export async function runEvaluationOfferExpiry() {
  const admin = getPlatformAdminDatabase();
  const orgs = await sql<{
    id: string;
  }>`SELECT id FROM organizations WHERE status='active' ORDER BY id`.execute(
    admin,
  );
  return processExpiredOffers(
    orgs.rows.map((row) => row.id),
    {
      database: getDatabase(),
      clock: () => new Date(),
    },
  );
}
