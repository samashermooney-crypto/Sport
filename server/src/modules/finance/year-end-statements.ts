import { Temporal } from '@js-temporal/polyfill';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const yearEndStatementSchema = z.strictObject({
  orgId: z.uuid(),
  orgName: z.string(),
  year: z.number().int(),
  timezone: z.string(),
  currency: z.literal('USD'),
  paymentCount: z.number().int().nonnegative(),
  totalPaidCents: cents,
  refundedToOriginalCents: cents,
  movedToCreditCents: cents,
  donationPaidCents: cents,
  donationRefundedCents: cents,
});
export type YearEndStatement = z.output<typeof yearEndStatementSchema>;
export class StatementUnavailableError extends Error {}

interface SumRow {
  total: number;
  count: number;
}

function safeCents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new StatementUnavailableError('Statement money does not reconcile');
  return value;
}

/** Reports dated ledger cash flows without claiming donation deductibility. */
export class PostgresYearEndStatements {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async read(year: number): Promise<YearEndStatement> {
    if (!Number.isInteger(year) || year < 2000 || year > 2100)
      throw new RangeError('Statement year is invalid');
    return this.withOrg(this.context, async (trx) => {
      const org = await trx
        .selectFrom('organizations')
        .select(['name', 'timezone', 'currency'])
        .where('id', '=', this.context.orgId)
        .executeTakeFirstOrThrow();
      if (org.currency !== 'USD')
        throw new StatementUnavailableError(
          'Statement currency is unavailable',
        );
      const localStart = Temporal.PlainDate.from({ year, month: 1, day: 1 });
      const localEnd = localStart.add({ years: 1 });
      const start = localStart
        .toZonedDateTime({ timeZone: org.timezone, plainTime: '00:00' })
        .toInstant()
        .toString();
      const end = localEnd
        .toZonedDateTime({ timeZone: org.timezone, plainTime: '00:00' })
        .toInstant()
        .toString();
      const missingDate = await sql<{ missing: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM payments
          WHERE org_id = ${this.context.orgId}::uuid
            AND account_id = ${this.context.actor.accountId}::uuid
            AND status = 'succeeded' AND succeeded_at IS NULL
          UNION ALL
          SELECT 1 FROM refunds r
          JOIN payments p ON p.org_id = r.org_id AND p.id = r.payment_id
          WHERE r.org_id = ${this.context.orgId}::uuid
            AND p.account_id = ${this.context.actor.accountId}::uuid
            AND r.status = 'succeeded' AND r.succeeded_at IS NULL
        ) AS missing
      `.execute(trx);
      if (missingDate.rows[0]?.missing)
        throw new StatementUnavailableError(
          'Historic money lacks a settlement date',
        );
      const missingShares = await sql<{ missing: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM payments p
          JOIN payment_allocations pa ON pa.org_id = p.org_id
            AND pa.payment_id = p.id
          JOIN invoice_lines il ON il.org_id = pa.org_id
            AND il.invoice_id = pa.invoice_id AND il.kind = 'donation'
          WHERE p.org_id = ${this.context.orgId}::uuid
            AND p.account_id = ${this.context.actor.accountId}::uuid
            AND p.status = 'succeeded'
            AND p.succeeded_at >= ${start}::timestamptz
            AND p.succeeded_at < ${end}::timestamptz
            AND NOT EXISTS (SELECT 1 FROM payment_line_allocations pla
              WHERE pla.org_id = pa.org_id AND pla.payment_id = pa.payment_id
                AND pla.invoice_id = pa.invoice_id)
          UNION ALL
          SELECT 1 FROM refunds r
          JOIN payments p ON p.org_id = r.org_id AND p.id = r.payment_id
          JOIN payment_allocations pa ON pa.org_id = p.org_id
            AND pa.payment_id = p.id
          JOIN invoice_lines il ON il.org_id = pa.org_id
            AND il.invoice_id = pa.invoice_id AND il.kind = 'donation'
          WHERE r.org_id = ${this.context.orgId}::uuid
            AND p.account_id = ${this.context.actor.accountId}::uuid
            AND r.status = 'succeeded'
            AND r.succeeded_at >= ${start}::timestamptz
            AND r.succeeded_at < ${end}::timestamptz
            AND NOT EXISTS (SELECT 1 FROM refund_allocations ra
              WHERE ra.org_id = r.org_id AND ra.refund_id = r.id)
        ) AS missing
      `.execute(trx);
      if (missingShares.rows[0]?.missing)
        throw new StatementUnavailableError(
          'Historic donation allocation is unavailable',
        );
      const payments = await sql<SumRow>`
        SELECT coalesce(sum(amount_cents), 0)::bigint AS total,
          count(*)::integer AS count FROM payments
        WHERE org_id = ${this.context.orgId}::uuid
          AND account_id = ${this.context.actor.accountId}::uuid
          AND status = 'succeeded'
          AND succeeded_at >= ${start}::timestamptz
          AND succeeded_at < ${end}::timestamptz
      `.execute(trx);
      const refunds = await sql<{ destination: string; total: number }>`
        SELECT r.destination, sum(r.amount_cents)::bigint AS total
        FROM refunds r JOIN payments p ON p.org_id = r.org_id
          AND p.id = r.payment_id
        WHERE r.org_id = ${this.context.orgId}::uuid
          AND p.account_id = ${this.context.actor.accountId}::uuid
          AND r.status = 'succeeded'
          AND r.succeeded_at >= ${start}::timestamptz
          AND r.succeeded_at < ${end}::timestamptz
        GROUP BY r.destination
      `.execute(trx);
      const donations = await sql<{ paid: number; refunded: number }>`
        SELECT
          (SELECT coalesce(sum(pla.amount_cents), 0)::bigint
            FROM payment_line_allocations pla
            JOIN payments p ON p.org_id = pla.org_id AND p.id = pla.payment_id
            JOIN invoice_lines il ON il.org_id = pla.org_id
              AND il.id = pla.invoice_line_id
            WHERE pla.org_id = ${this.context.orgId}::uuid
              AND p.account_id = ${this.context.actor.accountId}::uuid
              AND p.status = 'succeeded' AND il.kind = 'donation'
              AND p.succeeded_at >= ${start}::timestamptz
              AND p.succeeded_at < ${end}::timestamptz) AS paid,
          (SELECT coalesce(sum(ra.amount_cents), 0)::bigint
            FROM refund_allocations ra
            JOIN refunds r ON r.org_id = ra.org_id AND r.id = ra.refund_id
            JOIN payments p ON p.org_id = r.org_id AND p.id = r.payment_id
            JOIN invoice_lines il ON il.org_id = ra.org_id
              AND il.id = ra.invoice_line_id
            WHERE ra.org_id = ${this.context.orgId}::uuid
              AND p.account_id = ${this.context.actor.accountId}::uuid
              AND r.status = 'succeeded' AND il.kind = 'donation'
              AND r.succeeded_at >= ${start}::timestamptz
              AND r.succeeded_at < ${end}::timestamptz) AS refunded
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'finance.statement_read',
        entityType: 'organization',
        entityId: this.context.orgId,
        changes: { year: { tier: 'internal', after: year } },
      });
      const byDestination = new Map(
        refunds.rows.map((row) => [row.destination, safeCents(row.total)]),
      );
      if (
        [...byDestination.keys()].some(
          (value) => value !== 'original_method' && value !== 'credit',
        )
      )
        throw new StatementUnavailableError(
          'Refund destination is unavailable',
        );
      return yearEndStatementSchema.parse({
        orgId: this.context.orgId,
        orgName: org.name,
        year,
        timezone: org.timezone,
        currency: 'USD',
        paymentCount: payments.rows[0]?.count ?? 0,
        totalPaidCents: safeCents(payments.rows[0]?.total ?? 0),
        refundedToOriginalCents: byDestination.get('original_method') ?? 0,
        movedToCreditCents: byDestination.get('credit') ?? 0,
        donationPaidCents: safeCents(donations.rows[0]?.paid ?? 0),
        donationRefundedCents: safeCents(donations.rows[0]?.refunded ?? 0),
      });
    });
  }
}
