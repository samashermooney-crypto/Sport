import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { appendAuditEvent } from '../audit/service.js';

export class BillingCustomerConflictError extends Error {}

interface ClaimRow {
  id: string;
  stripe_customer_id: string | null;
  customer_claim_status: string;
  customer_claim_key: string | null;
}

/** A durable, single-org claim fences ambiguous Stripe Customer creation. */
export class PostgresBillingCustomerClaims {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async begin(): Promise<{ customerId: string } | { key: string }> {
    return this.withOrg(this.context, async (trx) => {
      const key = `billing-customer:${this.context.orgId}`;
      await sql`
        INSERT INTO org_subscriptions
          (id, org_id, stripe_customer_id, customer_claim_status, customer_claim_key)
        VALUES (${newId()}::uuid, ${this.context.orgId}::uuid,
          NULL, 'reserved', ${key})
        ON CONFLICT (org_id) DO NOTHING
      `.execute(trx);
      const result = await sql<ClaimRow>`
        SELECT id, stripe_customer_id, customer_claim_status, customer_claim_key
        FROM org_subscriptions WHERE org_id = ${this.context.orgId}::uuid
        FOR UPDATE
      `.execute(trx);
      const row = result.rows[0];
      if (!row) throw new Error('Billing Customer claim is missing');
      if (row.customer_claim_status === 'complete') {
        if (!row.stripe_customer_id)
          throw new Error('Completed Billing Customer claim is inconsistent');
        return { customerId: row.stripe_customer_id };
      }
      if (
        row.customer_claim_status !== 'reserved' ||
        row.customer_claim_key !== key
      )
        throw new BillingCustomerConflictError(
          'Billing Customer creation needs reconciliation',
        );
      await sql`
        UPDATE org_subscriptions SET customer_claim_status = 'external_started'
        WHERE org_id = ${this.context.orgId}::uuid AND id = ${row.id}::uuid
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'org_subscription.customer_creation_started',
        entityType: 'org_subscription',
        entityId: row.id,
        changes: {},
      });
      return { key };
    });
  }

  async complete(key: string, customerId: string): Promise<void> {
    const id = z.string().startsWith('cus_').parse(customerId);
    await this.withOrg(this.context, async (trx) => {
      const result = await sql<ClaimRow>`
        SELECT id, stripe_customer_id, customer_claim_status, customer_claim_key
        FROM org_subscriptions WHERE org_id = ${this.context.orgId}::uuid
        FOR UPDATE
      `.execute(trx);
      const row = result.rows[0];
      if (!row || row.customer_claim_key !== key)
        throw new BillingCustomerConflictError(
          'Billing Customer claim changed',
        );
      if (row.customer_claim_status === 'complete') {
        if (row.stripe_customer_id === id) return;
        throw new BillingCustomerConflictError(
          'Billing Customer claim has another Customer',
        );
      }
      if (row.customer_claim_status !== 'external_started')
        throw new BillingCustomerConflictError(
          'Billing Customer creation has not started',
        );
      await sql`
        UPDATE org_subscriptions SET stripe_customer_id = ${id},
          customer_claim_status = 'complete', version = version + 1
        WHERE org_id = ${this.context.orgId}::uuid AND id = ${row.id}::uuid
      `.execute(trx);
      await appendAuditEvent(trx, this.context, {
        action: 'org_subscription.customer_created',
        entityType: 'org_subscription',
        entityId: row.id,
        changes: {},
      });
    });
  }
}

/** Never retries an external-started claim after an ambiguous provider call. */
export class BillingCustomerService {
  constructor(
    private readonly claims: Pick<
      PostgresBillingCustomerClaims,
      'begin' | 'complete'
    >,
    private readonly gateway: Pick<PaymentsGateway, 'createBillingCustomer'>,
  ) {}

  async getOrCreate(input: {
    orgId: string;
    name: string;
    email: string;
  }): Promise<string> {
    const claim = await this.claims.begin();
    if ('customerId' in claim) return claim.customerId;
    const customer = await this.gateway.createBillingCustomer({
      ...input,
      idempotencyKey: claim.key,
    });
    await this.claims.complete(claim.key, customer.id);
    return customer.id;
  }
}
