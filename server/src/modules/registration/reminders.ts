import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg } from '../../db/withOrg.js';
import { systemWorkerActorId } from '../jobs/credentials-expiry.js';

import { PostgresRegistrationLifecycle } from './lifecycle.js';
import { enqueueRegistrationNotice } from './notices.js';

export interface RegistrationReminderDependencies {
  database: Kysely<DB>;
  organizationIds?: readonly string[];
}

export async function enqueueRegistrationReminders(
  dependencies: RegistrationReminderDependencies,
): Promise<number> {
  const organizationIds =
    dependencies.organizationIds ??
    (
      await dependencies.database
        .selectFrom('organizations')
        .select('id')
        .where('status', '=', 'active')
        .orderBy('id')
        .execute()
    ).map(({ id }) => id);
  const withOrg = createWithOrg(dependencies.database);
  let queued = 0;

  for (const orgId of organizationIds) {
    const context = { orgId, actor: { accountId: systemWorkerActorId } };
    queued += await withOrg(context, async (trx) => {
      const expiredOffers = await sql<{ offering_id: string }>`
        SELECT offering_id FROM waitlist_entries
        WHERE org_id = ${orgId}::uuid AND status = 'offered'
          AND offer_expires_at <= now()
        ORDER BY offering_id, id
        FOR UPDATE SKIP LOCKED LIMIT 100
      `.execute(trx);
      const lifecycle = new PostgresRegistrationLifecycle(
        dependencies.database,
        context,
      );
      for (const offeringId of new Set(
        expiredOffers.rows.map(({ offering_id }) => offering_id),
      ))
        await lifecycle.advanceWaitlist(trx, orgId, offeringId);

      const offers = await sql<{
        id: string;
        account_id: string;
        offer_expires_at: Date;
      }>`
        SELECT w.id, c.account_id, w.offer_expires_at
        FROM waitlist_entries w
        JOIN checkouts c ON c.org_id = w.org_id AND c.id = w.checkout_id
        WHERE w.org_id = ${orgId}::uuid AND w.status = 'offered'
          AND w.expiring_notified_at IS NULL
          AND w.offer_expires_at > now()
          AND w.offer_expires_at <= now() + interval '6 hours'
        ORDER BY w.offer_expires_at, w.id
        FOR UPDATE OF w SKIP LOCKED LIMIT 100
      `.execute(trx);
      let orgQueued = 0;
      for (const offer of offers.rows) {
        const updated = await trx
          .updateTable('waitlist_entries')
          .set({ expiring_notified_at: sql`now()` })
          .where('org_id', '=', orgId)
          .where('id', '=', offer.id)
          .where('expiring_notified_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!updated) continue;
        if (
          await enqueueRegistrationNotice(trx, context, {
            kind: 'waitlist_offer_expiring',
            sourceId: offer.id,
            accountId: offer.account_id,
            payload: { expiresAt: offer.offer_expires_at.toISOString() },
          })
        )
          orgQueued += 1;
      }

      const checkouts = await sql<{
        id: string;
        account_id: string;
      }>`
        SELECT id, account_id FROM checkouts
        WHERE org_id = ${orgId}::uuid AND status = 'awaiting_payment'
          AND reminder_sent_at IS NULL
          AND created_at <= now() - interval '24 hours'
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED LIMIT 100
      `.execute(trx);
      for (const checkout of checkouts.rows) {
        const updated = await trx
          .updateTable('checkouts')
          .set({ reminder_sent_at: sql`now()` })
          .where('org_id', '=', orgId)
          .where('id', '=', checkout.id)
          .where('status', '=', 'awaiting_payment')
          .where('reminder_sent_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!updated) continue;
        if (
          await enqueueRegistrationNotice(trx, context, {
            kind: 'checkout_reminder',
            sourceId: checkout.id,
            accountId: checkout.account_id,
            payload: { checkoutId: checkout.id },
          })
        )
          orgQueued += 1;
      }
      return orgQueued;
    });
  }
  return queued;
}
