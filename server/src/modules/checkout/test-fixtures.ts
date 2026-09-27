import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

/** Fixture bridge for tests whose legacy snapshots do not exercise price freeze. */
export async function bindFixtureInvoice(
  database: Kysely<DB>,
  context: OrgContext,
  checkoutId: string,
  invoiceId: string,
): Promise<void> {
  await createWithOrg(database)(context, async (trx) => {
    const updated = await sql<{ id: string }>`
      UPDATE checkouts SET invoice_id = ${invoiceId}::uuid
      WHERE org_id = ${context.orgId}::uuid AND id = ${checkoutId}::uuid
        AND invoice_id IS NULL RETURNING id
    `.execute(trx);
    if (updated.rows.length !== 1)
      throw new Error('Fixture checkout invoice link failed');
  });
}
