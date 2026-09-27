import { Temporal } from '@js-temporal/polyfill';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

export const creditBalanceSchema = z.strictObject({
  orgId: z.uuid(),
  accountBalanceCents: z.number().int().nonnegative(),
  householdBalances: z.array(
    z.strictObject({
      householdId: z.uuid(),
      householdName: z.string(),
      balanceCents: z.number().int().nonnegative(),
    }),
  ),
  totalAvailableCents: z.number().int().nonnegative(),
  asOfLocalDate: z.iso.date(),
});
export type CreditBalance = z.output<typeof creditBalanceSchema>;

interface BalanceRow {
  account_id: string | null;
  household_id: string | null;
  balance_cents: number;
}

/** Sums unexpired source balances for one payer and linked responsible households. */
export class PostgresPayerCreditBalances {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async read(): Promise<CreditBalance> {
    return this.withOrg(this.context, async (trx) => {
      const org = await trx
        .selectFrom('organizations')
        .select('timezone')
        .where('id', '=', this.context.orgId)
        .executeTakeFirstOrThrow();
      const today = Temporal.Instant.from(this.now().toISOString())
        .toZonedDateTimeISO(org.timezone)
        .toPlainDate()
        .toString();
      const households = await sql<{ id: string; name: string }>`
        SELECT DISTINCT h.id, h.name FROM households h
        JOIN household_members hm ON hm.org_id = h.org_id
          AND hm.household_id = h.id
        JOIN person_account_links pal ON pal.org_id = hm.org_id
          AND pal.person_id = hm.person_id
        WHERE h.org_id = ${this.context.orgId}::uuid
          AND h.status = 'active'
          AND hm.removed_at IS NULL
          AND hm.financially_responsible = true
          AND hm.role IN ('guardian', 'other_adult')
          AND pal.account_id = ${this.context.actor.accountId}::uuid
          AND pal.relationship = 'self' AND pal.revoked_at IS NULL
      `.execute(trx);
      const householdIds = households.rows.map((row) => row.id);
      const rows = await sql<BalanceRow>`
        SELECT issue.account_id, issue.household_id,
          (issue.amount_cents + coalesce(sum(debit.amount_cents), 0))::bigint
            AS balance_cents
        FROM credits issue
        LEFT JOIN credits debit ON debit.org_id = issue.org_id
          AND debit.source_credit_id = issue.id
        WHERE issue.org_id = ${this.context.orgId}::uuid
          AND issue.kind = 'issued'
          AND (issue.expires_on IS NULL OR issue.expires_on >= ${today}::date)
          AND (issue.account_id = ${this.context.actor.accountId}::uuid
            OR issue.household_id = ANY(${householdIds}::uuid[]))
        GROUP BY issue.id, issue.account_id, issue.household_id,
          issue.amount_cents
      `.execute(trx);
      let accountBalanceCents = 0;
      const householdTotals = new Map(householdIds.map((id) => [id, 0]));
      for (const row of rows.rows) {
        if (!Number.isSafeInteger(row.balance_cents) || row.balance_cents < 0)
          throw new Error('Credit source is not reconciled');
        if (row.account_id === this.context.actor.accountId)
          accountBalanceCents += row.balance_cents;
        else if (row.household_id && householdTotals.has(row.household_id))
          householdTotals.set(
            row.household_id,
            (householdTotals.get(row.household_id) ?? 0) + row.balance_cents,
          );
      }
      const householdBalances = households.rows
        .map((household) => ({
          householdId: household.id,
          householdName: household.name,
          balanceCents: householdTotals.get(household.id) ?? 0,
        }))
        .filter((household) => household.balanceCents > 0);
      const totalAvailableCents =
        accountBalanceCents +
        householdBalances.reduce((sum, item) => sum + item.balanceCents, 0);
      if (
        !Number.isSafeInteger(accountBalanceCents) ||
        householdBalances.some(
          (item) => !Number.isSafeInteger(item.balanceCents),
        ) ||
        !Number.isSafeInteger(totalAvailableCents)
      )
        throw new Error('Credit balance exceeds safe integer cents');
      await appendAuditEvent(trx, this.context, {
        action: 'credit.balance_read',
        entityType: 'organization',
        entityId: this.context.orgId,
        changes: { balanceCents: { tier: 'internal', after: '[read]' } },
      });
      return creditBalanceSchema.parse({
        orgId: this.context.orgId,
        accountBalanceCents,
        householdBalances,
        totalAvailableCents,
        asOfLocalDate: today,
      });
    });
  }
}
