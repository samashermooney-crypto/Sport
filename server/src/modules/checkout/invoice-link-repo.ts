import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';
import { frozenChargeSnapshotSchema } from '../finance/frozen-charge-repo.js';

/** Binds exactly one issued checkout invoice before any PaymentIntent is allowed. */
export class PostgresCheckoutInvoiceLinker {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async link(checkoutId: string, invoiceId: string): Promise<void> {
    await this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select(['account_id', 'status', 'pricing_snapshot'])
        .select(sql<string | null>`invoice_id`.as('invoice_id'))
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !checkout ||
        checkout.account_id !== this.context.actor.accountId ||
        checkout.status !== 'awaiting_payment'
      )
        throw new Error('Checkout invoice source is unavailable');
      if (checkout.invoice_id === invoiceId) return;
      if (checkout.invoice_id)
        throw new Error('Checkout is already linked to another invoice');
      const snapshot = frozenChargeSnapshotSchema.parse(
        checkout.pricing_snapshot,
      );
      const invoice = await trx
        .selectFrom('invoices')
        .select([
          'account_id',
          'source',
          'status',
          'subtotal_cents',
          'discount_cents',
          'service_fee_cents',
          'tax_cents',
          'total_cents',
          'credit_applied_cents',
          'balance_cents',
        ])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', invoiceId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !invoice ||
        invoice.account_id !== checkout.account_id ||
        invoice.source !== 'checkout' ||
        invoice.status !== 'open' ||
        invoice.subtotal_cents !== snapshot.subtotalCents ||
        invoice.discount_cents !== snapshot.discountCents + snapshot.aidCents ||
        invoice.service_fee_cents !== snapshot.serviceFeeCents ||
        invoice.tax_cents !== snapshot.taxCents ||
        invoice.total_cents !== snapshot.invoiceTotalCents ||
        invoice.credit_applied_cents !== snapshot.creditAppliedCents ||
        invoice.balance_cents !== snapshot.chargeNowCents
      )
        throw new Error(
          'Checkout invoice does not reconcile with frozen pricing',
        );
      const linked = await sql<{ id: string }>`
        UPDATE checkouts SET invoice_id = ${invoiceId}::uuid, version = version + 1
        WHERE org_id = ${this.context.orgId}::uuid AND id = ${checkoutId}::uuid
          AND invoice_id IS NULL RETURNING id
      `.execute(trx);
      if (!linked.rows[0]) throw new Error('Checkout invoice link changed');
      await appendAuditEvent(trx, this.context, {
        action: 'checkout.invoice_linked',
        entityType: 'checkout',
        entityId: checkoutId,
        changes: { invoiceId: { tier: 'internal', after: invoiceId } },
      });
    });
  }
}
