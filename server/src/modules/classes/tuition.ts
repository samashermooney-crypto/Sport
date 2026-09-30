import { tuitionDuringPause } from '@shared/algorithms/proration';
import { allocate } from '@shared/money';
import type { TuitionSubscription, TuitionTier } from '@shared/schemas/classes';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { requireVersion } from '../../lib/version-check.js';
import { appendAuditEvent } from '../audit/service.js';
import type { NewInvoiceLine } from '../finance/invoices.js';

import { sessionDatesInRange, dateOnly } from './enrollments.js';
import { ClassesNotFoundError } from './errors.js';

/**
 * Monthly tuition for one offering given the family's total classes/week in
 * it. A tier table prices the whole family for that offering; without tiers
 * each enrolled athlete pays price_cents and sibling_discount_bps[index]
 * discounts the (index+1)-th cheapest enrollment.
 */
export function tuitionForOffering(
  familyClassesPerWeek: number,
  perEnrollmentPrices: readonly number[],
  tiers: readonly TuitionTier[],
  siblingDiscountBps: readonly number[],
): number {
  if (tiers.length) {
    const sorted = [...tiers].sort((a, b) => {
      if (a.maxClassesPerWeek === null) return 1;
      if (b.maxClassesPerWeek === null) return -1;
      return a.maxClassesPerWeek - b.maxClassesPerWeek;
    });
    const tier =
      sorted.find(
        (item) =>
          item.maxClassesPerWeek === null ||
          familyClassesPerWeek <= item.maxClassesPerWeek,
      ) ?? sorted.at(-1);
    return tier?.amountCents ?? 0;
  }
  const ordered = [...perEnrollmentPrices].sort((a, b) => b - a);
  let total = 0;
  ordered.forEach((price, index) => {
    const bps =
      index === 0
        ? 0
        : (siblingDiscountBps[index - 1] ?? siblingDiscountBps.at(-1) ?? 0);
    total += allocate(price, [10_000 - bps, bps])[0] ?? 0;
  });
  return total;
}

interface SubscriptionRow {
  id: string;
  account_id: string;
  household_id: string;
  household_name: string;
  status: string;
  billing_day: number;
  payment_method_id: string | null;
  next_bill_on: string;
  proration: string;
  withdrawal_notice_days: number;
  paused_until: string | null;
  active_enrollments: number;
  monthly_cents: number | null;
  version: number;
}

function mapSubscription(row: SubscriptionRow): TuitionSubscription {
  return {
    id: row.id,
    accountId: row.account_id,
    householdId: row.household_id,
    householdName: row.household_name,
    status: row.status as TuitionSubscription['status'],
    billingDay: row.billing_day,
    paymentMethodId: row.payment_method_id,
    nextBillOn: dateOnly(row.next_bill_on),
    proration: row.proration as TuitionSubscription['proration'],
    withdrawalNoticeDays: row.withdrawal_notice_days,
    pausedUntil: row.paused_until ? dateOnly(row.paused_until) : null,
    activeEnrollments: row.active_enrollments,
    monthlyCents: row.monthly_cents,
    version: row.version,
  };
}

export class PostgresTuitionSubscriptions {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async list(input: {
    status?: string;
    accountId?: string;
    limit: number;
  }): Promise<TuitionSubscription[]> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<SubscriptionRow>`
        SELECT subscription.id, subscription.account_id,
          subscription.household_id, household.name AS household_name,
          subscription.status, subscription.billing_day,
          subscription.payment_method_id, subscription.next_bill_on::text,
          subscription.proration, subscription.withdrawal_notice_days,
          subscription.paused_until::text, subscription.version,
          (SELECT count(*)::integer FROM class_enrollments e
            WHERE e.org_id = subscription.org_id
              AND e.billing_subscription_id = subscription.id
              AND e.status IN ('trial', 'active', 'paused')) AS active_enrollments,
          NULL::integer AS monthly_cents
        FROM tuition_subscriptions subscription
        JOIN households household ON household.org_id = subscription.org_id
          AND household.id = subscription.household_id
        WHERE subscription.org_id = ${this.context.orgId}::uuid
          ${input.status ? sql`AND subscription.status = ${input.status}` : sql``}
          ${input.accountId ? sql`AND subscription.account_id = ${input.accountId}::uuid` : sql``}
        ORDER BY subscription.created_at DESC
        LIMIT ${input.limit}
      `.execute(trx);
      return rows.rows.map(mapSubscription);
    });
  }

  private async getInTransaction(
    trx: OrgTransaction,
    id: string,
  ): Promise<TuitionSubscription> {
    {
      const rows = await sql<SubscriptionRow>`
        SELECT subscription.id, subscription.account_id,
          subscription.household_id, household.name AS household_name,
          subscription.status, subscription.billing_day,
          subscription.payment_method_id, subscription.next_bill_on::text,
          subscription.proration, subscription.withdrawal_notice_days,
          subscription.paused_until::text, subscription.version,
          (SELECT count(*)::integer FROM class_enrollments e
            WHERE e.org_id = subscription.org_id
              AND e.billing_subscription_id = subscription.id
              AND e.status IN ('trial', 'active', 'paused')) AS active_enrollments,
          NULL::integer AS monthly_cents
        FROM tuition_subscriptions subscription
        JOIN households household ON household.org_id = subscription.org_id
          AND household.id = subscription.household_id
        WHERE subscription.org_id = ${this.context.orgId}::uuid
          AND subscription.id = ${id}::uuid
      `.execute(trx);
      const row = rows.rows[0];
      if (!row) throw new ClassesNotFoundError('Subscription not found');
      return mapSubscription(row);
    }
  }

  async get(id: string): Promise<TuitionSubscription> {
    return this.withOrg(this.context, (trx) => this.getInTransaction(trx, id));
  }

  /** Family's own subscription (portal). */
  async findForAccount(): Promise<TuitionSubscription[]> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<SubscriptionRow>`
        SELECT subscription.id, subscription.account_id,
          subscription.household_id, household.name AS household_name,
          subscription.status, subscription.billing_day,
          subscription.payment_method_id, subscription.next_bill_on::text,
          subscription.proration, subscription.withdrawal_notice_days,
          subscription.paused_until::text, subscription.version,
          (SELECT count(*)::integer FROM class_enrollments e
            WHERE e.org_id = subscription.org_id
              AND e.billing_subscription_id = subscription.id
              AND e.status IN ('trial', 'active', 'paused')) AS active_enrollments,
          NULL::integer AS monthly_cents
        FROM tuition_subscriptions subscription
        JOIN households household ON household.org_id = subscription.org_id
          AND household.id = subscription.household_id
        WHERE subscription.org_id = ${this.context.orgId}::uuid
          AND subscription.account_id = ${this.context.actor.accountId}::uuid
        ORDER BY subscription.created_at DESC
        LIMIT 50
      `.execute(trx);
      return rows.rows.map(mapSubscription);
    });
  }

  async update(
    subscriptionId: string,
    input: {
      billingDay?: number;
      paymentMethodId?: string | null;
      autopayConsent?: boolean;
      proration?: 'session_count' | 'full_month' | 'no_charge_after_20th';
      withdrawalNoticeDays?: number;
      expectedVersion: number;
    },
  ): Promise<TuitionSubscription> {
    return this.withOrg(this.context, async (trx) => {
      const current = await trx
        .selectFrom('tuition_subscriptions')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', subscriptionId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new ClassesNotFoundError('Subscription not found');
      requireVersion(current, input.expectedVersion);
      const turningOffAutopay =
        input.autopayConsent === false ||
        (input.paymentMethodId === null && current.payment_method_id !== null);
      await trx
        .updateTable('tuition_subscriptions')
        .set({
          billing_day: input.billingDay ?? current.billing_day,
          payment_method_id:
            input.paymentMethodId === undefined
              ? current.payment_method_id
              : input.paymentMethodId,
          proration: input.proration ?? current.proration,
          withdrawal_notice_days:
            input.withdrawalNoticeDays ?? current.withdrawal_notice_days,
          mandate_text_version:
            input.autopayConsent === true
              ? 'tuition-autopay-v1'
              : turningOffAutopay
                ? null
                : current.mandate_text_version,
          mandate_accepted_at:
            input.autopayConsent === true
              ? new Date()
              : turningOffAutopay
                ? null
                : current.mandate_accepted_at,
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', subscriptionId)
        .execute();
      if (turningOffAutopay) {
        const invoices = await trx
          .selectFrom('tuition_invoices')
          .select('invoice_id')
          .where('org_id', '=', this.context.orgId)
          .where('tuition_subscription_id', '=', subscriptionId)
          .execute();
        const invoiceIds = invoices.map((row) => row.invoice_id);
        if (invoiceIds.length) {
          await trx
            .updateTable('autopay_authorizations')
            .set({ revoked_at: sql`now()` })
            .where('org_id', '=', this.context.orgId)
            .where('invoice_id', 'in', invoiceIds)
            .where('revoked_at', 'is', null)
            .execute();
          await trx
            .updateTable('installments')
            .set({
              autopay: false,
              payment_method_id: null,
              next_attempt_at: null,
              version: sql`version + 1`,
            })
            .where('org_id', '=', this.context.orgId)
            .where('invoice_id', 'in', invoiceIds)
            .where('autopay', '=', true)
            .where('status', 'in', ['scheduled', 'failed'])
            .execute();
        }
      }
      await appendAuditEvent(trx, this.context, {
        action: 'classes.subscription_updated',
        entityType: 'tuition_subscription',
        entityId: subscriptionId,
        changes: {},
      });
      return this.getInTransaction(trx, subscriptionId);
    });
  }
}

/** Build the invoice lines for one subscription's billing period. */
export async function buildTuitionLines(
  trx: OrgTransaction,
  context: OrgContext,
  subscriptionId: string,
  periodStart: string,
  periodEnd: string,
): Promise<{
  lines: NewInvoiceLine[];
  enrollmentIds: string[];
}> {
  const enrollments = await trx
    .selectFrom('class_enrollments as enrollment')
    .innerJoin('class_offerings as offering', (join) =>
      join
        .onRef('offering.org_id', '=', 'enrollment.org_id')
        .onRef('offering.id', '=', 'enrollment.class_offering_id'),
    )
    .innerJoin('people as person', (join) =>
      join
        .onRef('person.org_id', '=', 'enrollment.org_id')
        .onRef('person.id', '=', 'enrollment.person_id'),
    )
    .select([
      'enrollment.id',
      'enrollment.class_offering_id',
      'enrollment.classes_per_week',
      'enrollment.status',
      'enrollment.pause_from',
      'enrollment.pause_to',
      'enrollment.annual_fee_next_on',
      'offering.name as offering_name',
      'offering.price_cents',
      'offering.tuition_tiers',
      'offering.sibling_discount_bps',
      'offering.annual_fee_cents',
      'offering.annual_fee_interval_months',
      'person.first_name',
      'person.last_name',
    ])
    .where('enrollment.org_id', '=', context.orgId)
    .where('enrollment.billing_subscription_id', '=', subscriptionId)
    .where('enrollment.status', 'in', ['active', 'paused'])
    .where(sql<boolean>`enrollment.starts_on <= ${periodEnd}::date`)
    .where((eb) =>
      eb.or([
        eb('enrollment.ends_on', 'is', null),
        sql<boolean>`enrollment.ends_on >= ${periodStart}::date`,
      ]),
    )
    .execute();
  if (!enrollments.length) return { lines: [], enrollmentIds: [] };

  const tiersSchema = z.array(
    z.strictObject({
      maxClassesPerWeek: z.number().int().positive().nullable(),
      amountCents: z.number().int().nonnegative(),
    }),
  );
  const subscription = await trx
    .selectFrom('tuition_subscriptions')
    .select(['proration'])
    .where('org_id', '=', context.orgId)
    .where('id', '=', subscriptionId)
    .executeTakeFirstOrThrow();

  const byOffering = new Map<
    string,
    {
      name: string;
      cpw: number;
      perEnrollment: { id: string; price: number; label: string }[];
      tiers: TuitionTier[];
      siblingBps: number[];
      paused: { id: string; from: string; to: string }[];
    }
  >();
  for (const row of enrollments) {
    const group = byOffering.get(row.class_offering_id) ?? {
      name: row.offering_name,
      cpw: 0,
      perEnrollment: [],
      tiers: tiersSchema.parse(row.tuition_tiers),
      siblingBps: z.array(z.number().int()).parse(row.sibling_discount_bps),
      paused: [],
    };
    if (row.status === 'paused' && row.pause_from && row.pause_to) {
      group.paused.push({
        id: row.id,
        from: dateOnly(row.pause_from),
        to: dateOnly(row.pause_to),
      });
    } else {
      group.cpw += row.classes_per_week;
    }
    group.perEnrollment.push({
      id: row.id,
      price: row.price_cents,
      label: `${row.offering_name} — ${row.first_name} ${row.last_name}`,
    });
    byOffering.set(row.class_offering_id, group);
  }

  const proration = subscription.proration as
    'session_count' | 'full_month' | 'no_charge_after_20th';
  const lines: NewInvoiceLine[] = [];
  const billedIds: string[] = [];
  for (const [offeringId, group] of byOffering) {
    if (!group.perEnrollment.length) continue;
    const monthSessions = await sessionDatesInRange(
      trx,
      context.orgId,
      offeringId,
      periodStart,
      periodEnd,
    );
    if (!monthSessions.length && !group.tiers.length) continue;
    // full_month bills the full tuition even while paused; session_count
    // and no_charge_after_20th bill only sessions outside the pause.
    const pausedSet = proration === 'full_month' ? [] : group.paused;
    const activeEnrollments = group.perEnrollment.filter(
      (item) => !pausedSet.some((paused) => paused.id === item.id),
    );
    const baseAmount = tuitionForOffering(
      group.cpw,
      activeEnrollments.map((item) => item.price),
      group.tiers,
      group.siblingBps,
    );
    if (baseAmount > 0)
      lines.push({
        kind: 'tuition',
        description: `${group.name} — monthly tuition (${String(group.cpw)} class${group.cpw === 1 ? '' : 'es'}/week)`,
        amountCents: baseAmount,
        refundable: true,
      });
    for (const paused of pausedSet) {
      const share = tuitionForOffering(
        1,
        [group.perEnrollment.find((item) => item.id === paused.id)?.price ?? 0],
        [],
        [],
      );
      const chargeable = tuitionDuringPause(
        share,
        monthSessions,
        paused.from > periodStart ? paused.from : periodStart,
        paused.to < periodEnd ? paused.to : periodEnd,
      );
      if (chargeable > 0)
        lines.push({
          kind: 'tuition',
          description: `${group.name} — paused enrollment (partial month)`,
          amountCents: chargeable,
          refundable: true,
        });
    }
    billedIds.push(...group.perEnrollment.map((item) => item.id));
  }

  for (const row of enrollments) {
    if (
      row.annual_fee_next_on &&
      dateOnly(row.annual_fee_next_on) >= periodStart &&
      dateOnly(row.annual_fee_next_on) <= periodEnd &&
      row.annual_fee_cents > 0
    ) {
      lines.push({
        kind: 'service_fee',
        description: `${row.offering_name} — annual registration fee`,
        amountCents: row.annual_fee_cents,
        refundable: false,
      });
      billedIds.push(row.id);
    }
  }
  return { lines, enrollmentIds: [...new Set(billedIds)] };
}

/** Advance annual fee dates on enrollments billed this period. */
export async function advanceAnnualFees(
  trx: OrgTransaction,
  context: OrgContext,
  enrollmentIds: readonly string[],
  periodEnd: string,
): Promise<void> {
  if (!enrollmentIds.length) return;
  await sql`
    UPDATE class_enrollments e
    SET annual_fee_next_on = (
      SELECT (e.annual_fee_next_on::date + (o.annual_fee_interval_months || ' months')::interval)::date
      FROM class_offerings o
      WHERE o.org_id = e.org_id AND o.id = e.class_offering_id
    ),
    version = e.version + 1,
    updated_at = now()
    WHERE e.org_id = ${context.orgId}::uuid
      AND e.id = ANY(${enrollmentIds}::uuid[])
      AND e.annual_fee_next_on IS NOT NULL
      AND e.annual_fee_next_on <= ${periodEnd}::date
  `.execute(trx);
}
