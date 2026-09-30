import { sql, type Kysely } from 'kysely';

import { getDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import { getPlatformAdminDatabase } from '../platform/admin';

const systemActor = '0199a1c0-0000-7000-8000-000000000001';
const subjectOrder = { program: 0, division: 1, offering: 2 } as const;

/**
 * Returns places held by abandoned checkouts to their capacity counters once
 * the hold expires. Checkouts awaiting payment keep their holds (payment
 * confirmation honors processing holds); open checkouts past their deadline
 * become `expired`. Returns the number of holds released.
 */
export async function releaseExpiredHolds(
  database: Kysely<DB>,
  orgId: string,
  now: Date,
  limit = 500,
): Promise<number> {
  return createWithOrg(database)(
    { orgId, actor: { accountId: systemActor } },
    async (trx) => {
      const holds = await sql<{
        id: string;
        checkout_id: string;
        subject_type: 'program' | 'division' | 'offering';
        subject_id: string;
        quantity: number;
      }>`
        SELECT hold.id, hold.checkout_id, hold.subject_type, hold.subject_id,
          hold.quantity
        FROM capacity_holds hold
        JOIN checkouts checkout
          ON checkout.org_id = hold.org_id AND checkout.id = hold.checkout_id
        WHERE hold.org_id = ${orgId}::uuid
          AND hold.expires_at <= ${now}
          AND hold.released_at IS NULL
          AND hold.converted_at IS NULL
          AND checkout.status IN ('open', 'expired', 'abandoned', 'failed')
        ORDER BY hold.expires_at, hold.id
        LIMIT ${limit}
        FOR UPDATE OF hold SKIP LOCKED
      `.execute(trx);
      if (!holds.rows.length) return 0;
      const totals = new Map<
        string,
        { subject: keyof typeof subjectOrder; id: string; quantity: number }
      >();
      for (const hold of holds.rows) {
        const key = `${hold.subject_type}:${hold.subject_id}`;
        const total = totals.get(key);
        if (total) total.quantity += hold.quantity;
        else
          totals.set(key, {
            subject: hold.subject_type,
            id: hold.subject_id,
            quantity: hold.quantity,
          });
      }
      // Same lock order as reservation to avoid deadlocks.
      const ordered = [...totals.values()].sort(
        (a, b) =>
          subjectOrder[a.subject] - subjectOrder[b.subject] ||
          a.id.localeCompare(b.id),
      );
      for (const total of ordered) {
        const counter = await trx
          .selectFrom('capacity_counters')
          .select(['id', 'held'])
          .where('org_id', '=', orgId)
          .where('subject_type', '=', total.subject)
          .where('subject_id', '=', total.id)
          .forUpdate()
          .executeTakeFirst();
        if (!counter || counter.held < total.quantity)
          throw new Error('Capacity hold does not reconcile');
        await trx
          .updateTable('capacity_counters')
          .set({
            held: sql`held - ${total.quantity}`,
            version: sql`version + 1`,
          })
          .where('org_id', '=', orgId)
          .where('id', '=', counter.id)
          .execute();
      }
      await trx
        .updateTable('capacity_holds')
        .set({ released_at: now })
        .where('org_id', '=', orgId)
        .where(
          'id',
          'in',
          holds.rows.map((hold) => hold.id),
        )
        .execute();
      await trx
        .updateTable('checkouts')
        .set({ status: 'expired', version: sql`version + 1` })
        .where('org_id', '=', orgId)
        .where('status', '=', 'open')
        .where('expires_at', '<=', now)
        .where('id', 'in', [
          ...new Set(holds.rows.map((hold) => hold.checkout_id)),
        ])
        .execute();
      return holds.rows.length;
    },
  );
}

export async function runHoldExpiryJob(): Promise<number> {
  const now = new Date();
  const orgs = await sql<{ org_id: string }>`
    SELECT DISTINCT org_id FROM capacity_holds
    WHERE expires_at <= ${now} AND released_at IS NULL AND converted_at IS NULL
  `.execute(getPlatformAdminDatabase());
  let released = 0;
  for (const row of orgs.rows)
    released += await releaseExpiredHolds(getDatabase(), row.org_id, now);
  return released;
}
