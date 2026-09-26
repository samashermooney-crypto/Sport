import { sql } from 'kysely';

import type { OrgTransaction } from './withOrg';

type CounterName = 'invoice' | 'order' | 'receipt' | 'donation_receipt' | 'bib';

export async function allocateOrgNumber(
  trx: OrgTransaction,
  orgId: string,
  name: CounterName,
): Promise<number> {
  await trx
    .insertInto('org_counters')
    .values({ org_id: orgId, name })
    .onConflict((conflict) => conflict.columns(['org_id', 'name']).doNothing())
    .execute();

  const row = await trx
    .updateTable('org_counters')
    .set({ next_value: sql<number>`next_value + 1` })
    .where('org_id', '=', orgId)
    .where('name', '=', name)
    .returning('next_value')
    .executeTakeFirstOrThrow();
  return row.next_value - 1;
}
