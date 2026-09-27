import { Temporal } from '@js-temporal/polyfill';
import { sql, type Kysely } from 'kysely';

import { getDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg } from '../../db/withOrg.js';
import { systemWorkerActorId } from '../jobs/credentials-expiry.js';

import { enqueueFinanceNotice } from './money-notices.js';

interface Candidate {
  id: string;
  account_id: string;
  exp_month: number | null;
  exp_year: number | null;
}

export interface CardExpiryJobDependencies {
  database: Kysely<DB>;
  now: () => Date;
  organizationIds?: readonly string[];
}

/** Alert 14 local calendar days before a charge whose saved card expires first. */
export async function queueExpiringCardNotices(
  dependencies: CardExpiryJobDependencies,
): Promise<{ queued: number }> {
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
  const instant = Temporal.Instant.from(dependencies.now().toISOString());
  const withOrg = createWithOrg(dependencies.database);
  let queued = 0;
  const errors: unknown[] = [];
  for (const orgId of organizationIds) {
    const context = { orgId, actor: { accountId: systemWorkerActorId } };
    try {
      queued += await withOrg(context, async (trx) => {
        const org = await trx
          .selectFrom('organizations')
          .select('timezone')
          .where('id', '=', orgId)
          .executeTakeFirstOrThrow();
        const due = instant
          .toZonedDateTimeISO(org.timezone)
          .toPlainDate()
          .add({ days: 14 });
        const dueOn = due.toString();
        const dueMonth = due.year * 12 + due.month;
        const candidates = await sql<Candidate>`
          SELECT installment.id, invoice.account_id,
            method.exp_month, method.exp_year
          FROM installments installment
          JOIN invoices invoice ON invoice.org_id = installment.org_id
            AND invoice.id = installment.invoice_id
          JOIN payment_methods method ON method.id = installment.payment_method_id
            AND method.account_id = invoice.account_id
          WHERE installment.org_id = ${orgId}::uuid
            AND installment.due_on = ${dueOn}::date
            AND installment.autopay = true
            AND installment.status = 'scheduled'
            AND invoice.status NOT IN ('void', 'draft')
            AND method.status = 'active' AND method.type = 'card'
            AND EXISTS (
              SELECT 1 FROM autopay_authorizations mandate
              WHERE mandate.org_id = installment.org_id
                AND mandate.invoice_id = installment.invoice_id
                AND mandate.account_id = invoice.account_id
                AND mandate.payment_method_id = installment.payment_method_id
                AND mandate.revoked_at IS NULL
            )
          ORDER BY installment.id
        `.execute(trx);
        let count = 0;
        for (const candidate of candidates.rows) {
          if (!candidate.exp_month || !candidate.exp_year) continue;
          if (candidate.exp_year * 12 + candidate.exp_month >= dueMonth)
            continue;
          if (
            await enqueueFinanceNotice(trx, context, {
              kind: 'card_expiring',
              sourceId: candidate.id,
              accountId: candidate.account_id,
            })
          )
            count += 1;
        }
        return count;
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Card expiry job failed');
  return { queued };
}

export function runCardExpiryJob(): Promise<{ queued: number }> {
  return queueExpiringCardNotices({
    database: getDatabase(),
    now: () => new Date(),
  });
}
