import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';
import { frozenChargeSnapshotSchema } from '../finance/frozen-charge-repo.js';

const discountLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        kind: z.string(),
        sourceId: z.string().optional(),
        amountCents: z.number().int(),
      }),
    )
    .optional(),
});

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
        .select(['account_id', 'status', 'expires_at', 'pricing_snapshot'])
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
      if (checkout.expires_at <= new Date())
        throw new Error('Checkout invoice source is unavailable');
      const snapshot = frozenChargeSnapshotSchema.parse(
        checkout.pricing_snapshot,
      );
      const discountLines = discountLinesSchema.parse(
        checkout.pricing_snapshot,
      ).lines;
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
      const codeIds = await sql<{ discount_code_id: string }>`
        SELECT discount_code_id FROM discount_code_reservations
        WHERE org_id = ${this.context.orgId}::uuid
          AND checkout_id = ${checkoutId}::uuid
        ORDER BY discount_code_id
      `.execute(trx);
      for (const codeId of codeIds.rows) {
        await trx
          .selectFrom('discount_codes')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', codeId.discount_code_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
      }
      const reservations = await sql<{
        id: string;
        discount_code_id: string;
        account_id: string;
        expires_at: Date;
        released_at: Date | null;
        redeemed_at: Date | null;
      }>`
        SELECT id, discount_code_id, account_id, expires_at,
          released_at, redeemed_at
        FROM discount_code_reservations
        WHERE org_id = ${this.context.orgId}::uuid
          AND checkout_id = ${checkoutId}::uuid FOR UPDATE
      `.execute(trx);
      if (reservations.rows.length && !discountLines)
        throw new Error('Discount reservation requires frozen pricing lines');
      for (const reservation of reservations.rows) {
        const amount = -(discountLines ?? [])
          .filter(
            (line) =>
              line.kind === 'discount' &&
              line.sourceId === reservation.discount_code_id,
          )
          .reduce((sum, line) => sum + line.amountCents, 0);
        if (
          !Number.isSafeInteger(amount) ||
          amount < 0 ||
          reservation.account_id !== checkout.account_id ||
          reservation.released_at ||
          reservation.redeemed_at ||
          reservation.expires_at <= new Date()
        )
          throw new Error(
            'Discount reservation does not reconcile with checkout',
          );
        if (amount === 0) {
          await sql`
            UPDATE discount_code_reservations SET released_at = now()
            WHERE org_id = ${this.context.orgId}::uuid
              AND id = ${reservation.id}::uuid
          `.execute(trx);
          continue;
        }
        await sql`
          INSERT INTO discount_redemptions
            (id, org_id, discount_code_id, account_id, invoice_id, amount_cents)
          VALUES (${newId()}::uuid, ${this.context.orgId}::uuid,
            ${reservation.discount_code_id}::uuid,
            ${checkout.account_id}::uuid, ${invoiceId}::uuid, ${amount})
        `.execute(trx);
        await sql`
          UPDATE discount_code_reservations
          SET redeemed_invoice_id = ${invoiceId}::uuid, redeemed_at = now()
          WHERE org_id = ${this.context.orgId}::uuid
            AND id = ${reservation.id}::uuid
        `.execute(trx);
      }
      await appendAuditEvent(trx, this.context, {
        action: 'checkout.invoice_linked',
        entityType: 'checkout',
        entityId: checkoutId,
        changes: { invoiceId: { tier: 'internal', after: invoiceId } },
      });
    });
  }
}
