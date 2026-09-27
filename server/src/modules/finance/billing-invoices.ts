import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { appendAuditEvent } from '../audit/service.js';

export type BillingInvoice = Awaited<
  ReturnType<PaymentsGateway['retrieveBillingInvoice']>
>;
class BillingInvoiceConflictError extends Error {}
const statusSchema = z.enum([
  'draft',
  'open',
  'paid',
  'uncollectible',
  'void',
  'unknown',
]);

/** Platform Billing invoices are mirrored separately from org payer invoices. */
export class PostgresBillingInvoices {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  applyLatest(invoice: BillingInvoice): Promise<'applied' | 'unchanged'> {
    if (
      !invoice.id.startsWith('in_') ||
      !invoice.subscriptionId?.startsWith('sub_') ||
      !invoice.customerId?.startsWith('cus_') ||
      invoice.currency !== 'usd'
    )
      throw new BillingInvoiceConflictError(
        'Billing invoice identity is invalid',
      );
    if (
      ![
        invoice.totalCents,
        invoice.amountPaidCents,
        invoice.amountDueCents,
        invoice.created,
      ].every(Number.isSafeInteger) ||
      invoice.amountPaidCents < 0 ||
      invoice.amountDueCents < 0 ||
      invoice.created < 0
    )
      throw new BillingInvoiceConflictError(
        'Billing invoice cents or date are invalid',
      );
    const status = statusSchema.parse(invoice.status ?? 'unknown');
    const createdAt = new Date(invoice.created * 1000);
    if (Number.isNaN(createdAt.getTime()))
      throw new BillingInvoiceConflictError('Billing invoice date is invalid');
    return this.withOrg(this.context, async (trx) => {
      const subscription = await sql<{
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
      }>`
        SELECT stripe_customer_id, stripe_subscription_id
        FROM org_subscriptions WHERE org_id = ${this.context.orgId}::uuid
      `.execute(trx);
      const owner = subscription.rows[0];
      if (
        owner?.stripe_customer_id !== invoice.customerId ||
        owner.stripe_subscription_id !== invoice.subscriptionId
      )
        throw new BillingInvoiceConflictError(
          'Billing invoice subscription is not owned by organization',
        );
      const current = await sql<{
        id: string;
        status: string;
        total_cents: number;
        amount_paid_cents: number;
        amount_due_cents: number;
      }>`
        SELECT id, status, total_cents, amount_paid_cents, amount_due_cents
        FROM org_billing_invoices
        WHERE org_id = ${this.context.orgId}::uuid AND stripe_invoice_id = ${invoice.id}
        FOR UPDATE
      `.execute(trx);
      const row = current.rows[0];
      if (
        row &&
        (row.amount_paid_cents > invoice.amountPaidCents ||
          (['paid', 'void'].includes(row.status) && row.status !== status) ||
          (row.status === 'open' && status === 'draft'))
      )
        throw new BillingInvoiceConflictError(
          'Billing invoice state regressed and needs reconciliation',
        );
      if (
        row &&
        row.status === status &&
        row.total_cents === invoice.totalCents &&
        row.amount_paid_cents === invoice.amountPaidCents &&
        row.amount_due_cents === invoice.amountDueCents
      )
        return 'unchanged';
      const id = row?.id ?? newId();
      const saved = await sql<{ id: string }>`
        INSERT INTO org_billing_invoices
          (id, org_id, stripe_invoice_id, stripe_subscription_id,
           stripe_customer_id, status, currency, total_cents,
           amount_paid_cents, amount_due_cents, stripe_created_at)
        VALUES (${id}::uuid, ${this.context.orgId}::uuid, ${invoice.id},
          ${invoice.subscriptionId}, ${invoice.customerId}, ${status},
          'usd', ${invoice.totalCents}, ${invoice.amountPaidCents},
          ${invoice.amountDueCents}, ${createdAt})
        ON CONFLICT (stripe_invoice_id) DO UPDATE SET
          status = EXCLUDED.status, total_cents = EXCLUDED.total_cents,
          amount_paid_cents = EXCLUDED.amount_paid_cents,
          amount_due_cents = EXCLUDED.amount_due_cents
        WHERE org_billing_invoices.org_id = EXCLUDED.org_id
          AND org_billing_invoices.stripe_customer_id = EXCLUDED.stripe_customer_id
          AND org_billing_invoices.stripe_subscription_id = EXCLUDED.stripe_subscription_id
        RETURNING id
      `.execute(trx);
      const savedId = saved.rows[0]?.id;
      if (!savedId)
        throw new BillingInvoiceConflictError(
          'Billing invoice belongs to another subscription',
        );
      await appendAuditEvent(trx, this.context, {
        action: 'org_billing_invoice.synced',
        entityType: 'org_billing_invoice',
        entityId: savedId,
        changes: {
          status: {
            tier: 'internal',
            before: row?.status ?? null,
            after: status,
          },
        },
      });
      return 'applied';
    });
  }
}
