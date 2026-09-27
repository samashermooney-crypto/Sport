import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { appendAuditEvent } from '../audit/service.js';

const subscriptionStatus = z.enum([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'canceled',
]);
export type BillingSubscription = Awaited<
  ReturnType<PaymentsGateway['retrieveBillingSubscription']>
>;
export class OrgBillingConflictError extends Error {}

interface SubscriptionRow {
  id: string;
  plan_id: string | null;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  status: string;
  current_period_end: Date | null;
  version: number;
}

/** A reserved Stripe Customer is the only entry point for subscription webhooks. */
export class PostgresOrgBilling {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async reserveCustomer(customerId: string): Promise<void> {
    if (!customerId.startsWith('cus_'))
      throw new RangeError('Invalid Stripe Customer');
    await this.withOrg(this.context, async (trx) => {
      const inserted = await sql<{ id: string }>`
        INSERT INTO org_subscriptions (id, org_id, stripe_customer_id)
        VALUES (${newId()}::uuid, ${this.context.orgId}::uuid, ${customerId})
        ON CONFLICT (org_id) DO NOTHING RETURNING id
      `.execute(trx);
      const insertedId = inserted.rows[0]?.id;
      if (insertedId) {
        await appendAuditEvent(trx, this.context, {
          action: 'org_subscription.customer_reserved',
          entityType: 'org_subscription',
          entityId: insertedId,
          changes: {},
        });
        return;
      }
      const existing = await sql<{ stripe_customer_id: string }>`
        SELECT stripe_customer_id FROM org_subscriptions
        WHERE org_id = ${this.context.orgId}::uuid
      `.execute(trx);
      if (existing.rows[0]?.stripe_customer_id !== customerId)
        throw new OrgBillingConflictError(
          'Organization has another Stripe Customer',
        );
    });
  }

  async syncLatest(
    latest: BillingSubscription,
  ): Promise<'applied' | 'unchanged'> {
    if (latest.orgId !== this.context.orgId || !latest.id.startsWith('sub_'))
      throw new OrgBillingConflictError(
        'Subscription organization is unverified',
      );
    if (!latest.customerId.startsWith('cus_'))
      throw new OrgBillingConflictError('Subscription Customer is invalid');
    const status = subscriptionStatus.parse(latest.status);
    if (
      latest.priceIds.length !== 1 ||
      !latest.priceIds[0]?.startsWith('price_')
    )
      throw new OrgBillingConflictError(
        'Subscription needs one platform plan price',
      );
    const periodEnd =
      latest.currentPeriodEnd === null
        ? null
        : new Date(latest.currentPeriodEnd * 1000);
    if (
      periodEnd &&
      (!Number.isSafeInteger(latest.currentPeriodEnd) ||
        Number.isNaN(periodEnd.getTime()))
    )
      throw new RangeError('Invalid subscription period end');
    return this.withOrg(this.context, async (trx) => {
      const plan = await sql<{
        id: string;
        application_fee_bps: number;
        application_fee_fixed_cents: number;
      }>`
        SELECT id, application_fee_bps, application_fee_fixed_cents
        FROM plans WHERE stripe_price_id = ${latest.priceIds[0]}
      `.execute(trx);
      const pricePlan = plan.rows[0];
      if (!pricePlan)
        throw new OrgBillingConflictError(
          'Subscription price has no platform plan',
        );
      const existing = await sql<SubscriptionRow>`
        SELECT id, plan_id, stripe_customer_id, stripe_subscription_id,
          status, current_period_end, version FROM org_subscriptions
        WHERE org_id = ${this.context.orgId}::uuid FOR UPDATE
      `.execute(trx);
      const row = existing.rows[0];
      if (!row || row.stripe_customer_id !== latest.customerId)
        throw new OrgBillingConflictError(
          'Subscription Customer is not reserved',
        );
      if (
        row.stripe_subscription_id &&
        row.stripe_subscription_id !== latest.id &&
        !['canceled', 'incomplete_expired'].includes(row.status)
      )
        throw new OrgBillingConflictError('Another subscription is current');
      if (
        row.plan_id === pricePlan.id &&
        row.stripe_subscription_id === latest.id &&
        row.status === status &&
        (row.current_period_end?.getTime() ?? null) ===
          (periodEnd?.getTime() ?? null)
      )
        return 'unchanged';
      await sql`
        UPDATE org_subscriptions SET plan_id = ${pricePlan.id}::uuid,
          stripe_subscription_id = ${latest.id}, status = ${status},
          current_period_end = ${periodEnd}, version = version + 1
        WHERE org_id = ${this.context.orgId}::uuid AND id = ${row.id}::uuid
      `.execute(trx);
      if (status === 'active' || status === 'trialing') {
        await sql`
          UPDATE organizations SET plan_id = ${pricePlan.id}::uuid,
            application_fee_bps = ${pricePlan.application_fee_bps},
            application_fee_fixed_cents = ${pricePlan.application_fee_fixed_cents},
            version = version + 1
          WHERE id = ${this.context.orgId}::uuid
        `.execute(trx);
        await sql`
          UPDATE billing_checkout_claims SET status = 'fulfilled'
          WHERE org_id = ${this.context.orgId}::uuid
            AND stripe_customer_id = ${latest.customerId}
            AND stripe_price_id = ${latest.priceIds[0]}
            AND status = 'created'
        `.execute(trx);
      }
      await appendAuditEvent(trx, this.context, {
        action: 'org_subscription.synced',
        entityType: 'org_subscription',
        entityId: row.id,
        changes: {
          status: { tier: 'internal', before: row.status, after: status },
          planId: {
            tier: 'internal',
            before: row.plan_id,
            after: pricePlan.id,
          },
        },
      });
      return 'applied';
    });
  }
}
