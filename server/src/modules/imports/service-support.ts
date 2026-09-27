import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';

export async function setBatchFailed(
  database: Kysely<DB>,
  orgId: string,
  batchId: string,
): Promise<void> {
  await sql`
    UPDATE import_batches SET status = 'failed'
    WHERE org_id = ${orgId} AND id = ${batchId}
      AND status IN ('validating', 'committing')
  `.execute(database);
  await sql`SELECT pg_notify('import_progress', ${JSON.stringify({ orgId, batchId })})`.execute(
    database,
  );
}
