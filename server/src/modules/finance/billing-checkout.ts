import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { appendAuditEvent } from '../audit/service.js';

export class BillingCheckoutConflictError extends Error {}
export const billingCheckoutInputSchema = z.strictObject({ planId: z.uuid() });
export const billingCheckoutResponseSchema = z.strictObject({
  sessionId: z.string().startsWith('cs_'),
  url: z.url().startsWith('https://checkout.stripe.com/'),
});

interface ClaimRow {
  id: string;
  plan_id: string;
  request_key: string;
  stripe_customer_id: string;
  stripe_price_id: string;
  status: string;
  stripe_session_id: string | null;
  checkout_url: string | null;
}

type BeginResult =
  | { kind: 'replay'; sessionId: string; url: string }
  | { kind: 'create'; claimId: string; customerId: string; priceId: string };

/** One active Checkout per org, with a durable external-start fence. */
export class PostgresBillingCheckoutClaims {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  begin(input: {
    orgId: string;
    planId: string;
    requestKey: string;
  }): Promise<BeginResult> {
    if (input.orgId !== this.context.orgId)
      throw new BillingCheckoutConflictError(
        'Billing Checkout organization changed',
      );
    const planId = z.uuid().parse(input.planId);
    const key = z.uuid().parse(input.requestKey);
    return this.withOrg(this.context, async (trx) => {
      const subscription = await sql<{
        stripe_customer_id: string | null;
        customer_claim_status: string;
        status: string;
      }>`
        SELECT stripe_customer_id, customer_claim_status, status
        FROM org_subscriptions WHERE org_id = ${this.context.orgId}::uuid
        FOR UPDATE
      `.execute(trx);
      const current = subscription.rows[0];
      if (
        !current ||
        current.customer_claim_status !== 'complete' ||
        !current.stripe_customer_id
      )
        throw new BillingCheckoutConflictError(
          'Billing Customer is unavailable',
        );
      const existing = await sql<ClaimRow>`
        SELECT * FROM billing_checkout_claims
        WHERE org_id = ${this.context.orgId}::uuid AND request_key = ${key}::uuid
        FOR UPDATE
      `.execute(trx);
      const replay = existing.rows[0];
      if (replay) {
        if (
          replay.plan_id !== planId ||
          replay.stripe_customer_id !== current.stripe_customer_id
        )
          throw new BillingCheckoutConflictError(
            'Billing Checkout key was reused',
          );
        if (
          ['created', 'fulfilled'].includes(replay.status) &&
          replay.stripe_session_id &&
          replay.checkout_url
        )
          return {
            kind: 'replay',
            sessionId: replay.stripe_session_id,
            url: replay.checkout_url,
          };
        throw new BillingCheckoutConflictError(
          'Billing Checkout needs reconciliation',
        );
      }
      if (
        !['pending', 'canceled', 'incomplete_expired'].includes(current.status)
      )
        throw new BillingCheckoutConflictError(
          'Use the Billing portal for an existing subscription',
        );
      const plan = await sql<{ stripe_price_id: string | null }>`
        SELECT stripe_price_id FROM plans WHERE id = ${planId}::uuid AND active = true
      `.execute(trx);
      const priceId = plan.rows[0]?.stripe_price_id;
      if (!priceId?.startsWith('price_'))
        throw new BillingCheckoutConflictError(
          'Active paid plan price is unavailable',
        );
      const other = await sql<{ id: string }>`
        SELECT id FROM billing_checkout_claims
        WHERE org_id = ${this.context.orgId}::uuid
          AND status IN ('reserved', 'external_started', 'created')
        LIMIT 1
      `.execute(trx);
      if (other.rows.length)
        throw new BillingCheckoutConflictError(
          'Another Billing Checkout is active',
        );
      const claimId = newId();
      await sql`
        INSERT INTO billing_checkout_claims
          (id, org_id, plan_id, request_key, stripe_customer_id,
           stripe_price_id, status)
        VALUES (${claimId}::uuid, ${this.context.orgId}::uuid,
          ${planId}::uuid, ${key}::uuid, ${current.stripe_customer_id},
          ${priceId}, 'external_started')
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'billing_checkout.external_started',
        entityType: 'billing_checkout',
        entityId: claimId,
        changes: { planId: { tier: 'internal', after: planId } },
      });
      return {
        kind: 'create',
        claimId,
        customerId: current.stripe_customer_id,
        priceId,
      };
    });
  }

  complete(
    claimId: string,
    result: { sessionId: string; url: string },
  ): Promise<void> {
    const id = z.uuid().parse(claimId);
    const parsed = billingCheckoutResponseSchema.parse(result);
    return this.withOrg(this.context, async (trx) => {
      const updated = await sql<{ id: string }>`
        UPDATE billing_checkout_claims SET status = 'created',
          stripe_session_id = ${parsed.sessionId}, checkout_url = ${parsed.url}
        WHERE org_id = ${this.context.orgId}::uuid AND id = ${id}::uuid
          AND status = 'external_started'
        RETURNING id
      `.execute(trx);
      if (!updated.rows.length)
        throw new BillingCheckoutConflictError(
          'Billing Checkout claim changed',
        );
      await appendAuditEvent(trx, this.context, {
        action: 'billing_checkout.created',
        entityType: 'billing_checkout',
        entityId: id,
        changes: {},
      });
    });
  }
}

export class BillingCheckoutService {
  constructor(
    private readonly claims: Pick<
      PostgresBillingCheckoutClaims,
      'begin' | 'complete'
    >,
    private readonly gateway: Pick<PaymentsGateway, 'createBillingCheckout'>,
  ) {}

  async start(input: {
    orgId: string;
    planId: string;
    requestKey: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ sessionId: string; url: string }> {
    const claim = await this.claims.begin(input);
    if (claim.kind === 'replay')
      return { sessionId: claim.sessionId, url: claim.url };
    const session = await this.gateway.createBillingCheckout({
      orgId: input.orgId,
      customerId: claim.customerId,
      priceId: claim.priceId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      idempotencyKey: `billing-checkout:${claim.claimId}`,
    });
    const result = billingCheckoutResponseSchema.parse({
      sessionId: session.id,
      url: session.url,
    });
    await this.claims.complete(claim.claimId, result);
    return result;
  }
}
