import { createHash } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import { getDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';
import { systemWorkerActorId } from '../jobs/credentials-expiry.js';

import { monthRange, dateOnly } from './enrollments.js';
import { offerNextWaitlistEntry } from './enrollments.js';
import { TUITION_AUTOPAY_TEXT } from './enrollments.js';
import { issueInvoiceInTransaction } from './invoice-writer.js';
import { advanceAnnualFees, buildTuitionLines } from './tuition.js';

/** Deterministic UUID (v8-style) from a seed — used for billing idempotency. */
function deterministicUuid(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  const byte6 = digest[6] ?? 0;
  const byte8 = digest[8] ?? 0;
  digest[6] = (byte6 & 0x0f) | 0x80;
  digest[8] = (byte8 & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function mandateHashFor(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function orgToday(trx: OrgTransaction, orgId: string): Promise<string> {
  const org = await trx
    .selectFrom('organizations')
    .select('timezone')
    .where('id', '=', orgId)
    .executeTakeFirstOrThrow();
  return new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone }).format(
    new Date(),
  );
}

/**
 * Bill one subscription for the month containing next_bill_on.
 * Returns the created invoice id, or null when nothing was due.
 */
async function billSubscription(
  trx: OrgTransaction,
  context: OrgContext,
  subscriptionId: string,
  today: string,
): Promise<{ invoiceId: string | null; billed: boolean; ended: boolean }> {
  const subscription = await trx
    .selectFrom('tuition_subscriptions')
    .selectAll()
    .where('org_id', '=', context.orgId)
    .where('id', '=', subscriptionId)
    .forUpdate()
    .executeTakeFirst();
  if (!subscription || subscription.status !== 'active')
    return { invoiceId: null, billed: false, ended: false };
  if (subscription.paused_until && dateOnly(subscription.paused_until) >= today)
    return { invoiceId: null, billed: false, ended: false };

  // Catch up through missed months until next_bill_on is in the future.
  let nextBillOn = dateOnly(subscription.next_bill_on);
  let billed = false;
  let lastInvoiceId: string | null = null;
  let dirty = false;
  while (nextBillOn <= today) {
    const period = monthRange(nextBillOn);
    const { lines, enrollmentIds } = await buildTuitionLines(
      trx,
      context,
      subscriptionId,
      period.start,
      period.end,
    );
    const nextBill = nextBillingDate(subscription.billing_day, nextBillOn);

    if (!enrollmentIds.length) {
      const live = await trx
        .selectFrom('class_enrollments')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('billing_subscription_id', '=', subscriptionId)
        .where('status', 'in', ['trial', 'active', 'paused'])
        .executeTakeFirst();
      if (!live) {
        await trx
          .updateTable('tuition_subscriptions')
          .set({
            status: 'ended',
            ended_at: sql`now()`,
            next_bill_on: nextBillOn,
            version: sql`version + 1`,
          })
          .where('org_id', '=', context.orgId)
          .where('id', '=', subscriptionId)
          .execute();
        return { invoiceId: lastInvoiceId, billed, ended: true };
      }
      nextBillOn = nextBill;
      dirty = true;
      continue;
    }

    const creationKey = deterministicUuid(
      `${context.orgId}:${subscriptionId}:${nextBillOn}`,
    );
    const invoice = await issueInvoiceInTransaction(trx, context, {
      orgId: context.orgId,
      accountId: subscription.account_id,
      householdId: subscription.household_id,
      source: 'tuition',
      memo: `Monthly tuition — ${period.start} to ${period.end}`,
      creationKey,
      dueOn: nextBillOn,
      lines,
    });
    await trx
      .insertInto('tuition_invoices')
      .values({
        id: newId(),
        org_id: context.orgId,
        tuition_subscription_id: subscriptionId,
        invoice_id: invoice.id,
        period_start: period.start,
        period_end: period.end,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['org_id', 'tuition_subscription_id', 'period_start'])
          .doNothing(),
      )
      .execute();

    if (subscription.payment_method_id && subscription.mandate_text_version) {
      const open = await trx
        .selectFrom('invoices')
        .select(['balance_cents'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', invoice.id)
        .executeTakeFirst();
      if (open && (open.balance_cents ?? 0) > 0) {
        const installmentId = newId();
        await trx
          .insertInto('installments')
          .values({
            id: installmentId,
            org_id: context.orgId,
            invoice_id: invoice.id,
            sequence: 1,
            due_on: nextBillOn,
            amount_cents: open.balance_cents ?? 0,
            autopay: true,
            payment_method_id: subscription.payment_method_id,
          })
          .onConflict((conflict) => conflict.doNothing())
          .execute();
        await sql`
          INSERT INTO autopay_authorizations
            (id, org_id, account_id, payment_method_id, invoice_id,
             mandate_text_version, mandate_text_hash, operation_key)
          VALUES (${newId()}::uuid, ${context.orgId}::uuid,
            ${subscription.account_id}::uuid,
            ${subscription.payment_method_id}::uuid, ${invoice.id}::uuid,
            ${subscription.mandate_text_version},
            ${mandateHashFor(TUITION_AUTOPAY_TEXT)},
            ${deterministicUuid(`${subscriptionId}:${invoice.id}`)}::uuid)
          ON CONFLICT DO NOTHING
        `.execute(trx);
      }
    }

    await advanceAnnualFees(trx, context, enrollmentIds, period.end);
    await appendAuditEvent(trx, context, {
      action: 'classes.tuition_billed',
      entityType: 'tuition_subscription',
      entityId: subscriptionId,
      changes: {
        invoiceId: { tier: 'internal', after: invoice.id },
        periodStart: { tier: 'internal', after: period.start },
      },
    });
    billed = true;
    lastInvoiceId = invoice.id;
    nextBillOn = nextBill;
    dirty = true;
  }

  if (dirty)
    await trx
      .updateTable('tuition_subscriptions')
      .set({ next_bill_on: nextBillOn, version: sql`version + 1` })
      .where('org_id', '=', context.orgId)
      .where('id', '=', subscriptionId)
      .execute();
  return { invoiceId: lastInvoiceId, billed, ended: false };
}

function nextBillingDate(billingDay: number, after: string): string {
  const date = Temporal.PlainDate.from(after);
  const nextMonth = new Temporal.PlainDate(
    date.add({ months: 1 }).year,
    date.add({ months: 1 }).month,
    Math.min(billingDay, 28),
  );
  return nextMonth.toString();
}

async function processOrg(
  database: Kysely<DB>,
  orgId: string,
  today: string,
): Promise<{ billed: number; expiredCredits: number; offersExpired: number }> {
  const context: OrgContext = {
    orgId,
    actor: { accountId: systemWorkerActorId },
  };
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const due = await trx
      .selectFrom('tuition_subscriptions')
      .select('id')
      .where('org_id', '=', orgId)
      .where('status', '=', 'active')
      .where('next_bill_on', '<=', new Date(today))
      .orderBy('next_bill_on')
      .limit(500)
      .execute();
    let billed = 0;
    for (const subscription of due) {
      const result = await billSubscription(
        trx,
        context,
        subscription.id,
        today,
      );
      if (result.billed) billed += 1;
    }

    const expiredCredits = await trx
      .updateTable('makeup_credits')
      .set({ status: 'expired', version: sql`version + 1` })
      .where('org_id', '=', orgId)
      .where('status', '=', 'available')
      .where('expires_on', '<', new Date(today))
      .returning('id')
      .execute();

    const expiredOffers = await trx
      .updateTable('class_waitlist_entries')
      .set({ status: 'expired', version: sql`version + 1` })
      .where('org_id', '=', orgId)
      .where('status', '=', 'offered')
      .where('offer_expires_at', '<', new Date())
      .returning(['id', 'class_offering_id', 'person_id'])
      .execute();
    const offeredOfferings = new Set<string>();
    for (const offer of expiredOffers) {
      if (offeredOfferings.has(offer.class_offering_id)) continue;
      offeredOfferings.add(offer.class_offering_id);
      await offerNextWaitlistEntry(trx, context, offer.class_offering_id);
    }

    // Auto-resume enrollments whose pause window has ended.
    await trx
      .updateTable('class_enrollments')
      .set({
        status: 'active',
        pause_from: null,
        pause_to: null,
        version: sql`version + 1`,
        updated_at: sql`now()`,
      })
      .where('org_id', '=', orgId)
      .where('status', '=', 'paused')
      .where('pause_to', '<', new Date(today))
      .execute();

    return {
      billed,
      expiredCredits: expiredCredits.length,
      offersExpired: expiredOffers.length,
    };
  });
}

export interface TuitionJobResult {
  organizations: number;
  billed: number;
  expiredCredits: number;
  expiredOffers: number;
}

export async function runTuitionBilling(
  database: Kysely<DB>,
  organizationIds?: readonly string[],
): Promise<TuitionJobResult> {
  const orgIds =
    organizationIds ??
    (
      await database
        .selectFrom('organizations')
        .select('id')
        .where('status', '=', 'active')
        .orderBy('id')
        .execute()
    ).map(({ id }) => id);
  const result: TuitionJobResult = {
    organizations: orgIds.length,
    billed: 0,
    expiredCredits: 0,
    expiredOffers: 0,
  };
  const errors: unknown[] = [];
  for (const orgId of orgIds) {
    try {
      const today = await createWithOrg(database)(
        { orgId, actor: { accountId: systemWorkerActorId } },
        (trx) => orgToday(trx, orgId),
      );
      const outcome = await processOrg(database, orgId, today);
      result.billed += outcome.billed;
      result.expiredCredits += outcome.expiredCredits;
      result.expiredOffers += outcome.offersExpired;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Tuition billing job failed');
  return result;
}

export function runTuitionJob(): Promise<TuitionJobResult> {
  return runTuitionBilling(getDatabase());
}
