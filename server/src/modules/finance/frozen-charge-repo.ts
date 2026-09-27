import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import {
  quoteCharge,
  type FrozenCharge,
  type FrozenChargeReader,
} from './service.js';

const cents = z.number().int().nonnegative();
const rate = z.object({ bps: cents.max(10_000), fixedCents: cents });
export const frozenPaymentTermsSchema = z.object({
  applicationRate: rate,
  serviceFee: z.discriminatedUnion('enabled', [
    z.object({ enabled: z.literal(false) }),
    z.discriminatedUnion('mode', [
      z.object({
        enabled: z.literal(true),
        mode: z.literal('cover_costs'),
        processing: rate.optional(),
      }),
      z.object({
        enabled: z.literal(true),
        mode: z.literal('custom'),
        custom: rate,
      }),
    ]),
  ]),
  statementDescriptorSuffix: z.string().trim().min(1).max(22).optional(),
});
export const frozenChargeSnapshotSchema = z.object({
  subtotalCents: cents,
  discountCents: cents,
  aidCents: cents,
  creditAppliedCents: cents,
  serviceFeeCents: cents,
  taxCents: cents,
  invoiceTotalCents: cents,
  chargeNowCents: cents.positive(),
  paymentTerms: frozenPaymentTermsSchema,
});

interface InvoiceRow {
  account_id: string;
  source: string;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  service_fee_cents: number;
  tax_cents: number;
  total_cents: number;
  credit_applied_cents: number;
  paid_cents: number;
  refunded_cents: number;
  disputed_cents: number;
  dispute_lost_cents: number;
  balance_cents: number | null;
}

/** Only a frozen checkout/invoice/customer/Connect combination can be charged. */
export class PostgresFrozenChargeReader implements FrozenChargeReader {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async load(input: {
    orgId: string;
    checkoutId: string;
    invoiceId: string;
    accountId: string;
  }): Promise<FrozenCharge | null> {
    if (
      input.orgId !== this.context.orgId ||
      input.accountId !== this.context.actor.accountId
    )
      throw new Error('Frozen charge actor or organization mismatch');
    return this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select([
          'account_id',
          'status',
          'expires_at',
          'version',
          'pricing_snapshot',
          sql<string | null>`invoice_id`.as('invoice_id'),
        ])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .executeTakeFirst();
      if (!checkout) return null;
      if (
        checkout.account_id !== input.accountId ||
        checkout.invoice_id !== input.invoiceId ||
        checkout.status !== 'awaiting_payment' ||
        checkout.expires_at.getTime() <= Date.now()
      )
        throw new Error('Checkout is not payable');
      const snapshot = frozenChargeSnapshotSchema.parse(
        checkout.pricing_snapshot,
      );
      const invoiceResult = await sql<InvoiceRow>`
        SELECT account_id, source, status, subtotal_cents, discount_cents,
          service_fee_cents, tax_cents, total_cents, credit_applied_cents,
          paid_cents, refunded_cents, disputed_cents, dispute_lost_cents,
          balance_cents FROM invoices
        WHERE org_id = ${input.orgId}::uuid AND id = ${input.invoiceId}::uuid
      `.execute(trx);
      const invoice = invoiceResult.rows[0];
      if (
        !invoice ||
        invoice.account_id !== input.accountId ||
        invoice.source !== 'checkout' ||
        !['open', 'partially_paid'].includes(invoice.status) ||
        invoice.paid_cents !== 0 ||
        invoice.refunded_cents !== 0 ||
        invoice.disputed_cents !== 0 ||
        invoice.dispute_lost_cents !== 0 ||
        invoice.subtotal_cents !== snapshot.subtotalCents ||
        invoice.discount_cents !== snapshot.discountCents + snapshot.aidCents ||
        invoice.service_fee_cents !== snapshot.serviceFeeCents ||
        invoice.tax_cents !== snapshot.taxCents ||
        invoice.total_cents !== snapshot.invoiceTotalCents ||
        invoice.credit_applied_cents !== snapshot.creditAppliedCents ||
        invoice.balance_cents !== snapshot.chargeNowCents
      )
        throw new Error('Frozen checkout invoice does not reconcile');
      const baseCents =
        snapshot.subtotalCents -
        snapshot.discountCents -
        snapshot.aidCents -
        snapshot.creditAppliedCents;
      if (!Number.isSafeInteger(baseCents) || baseCents < 0)
        throw new Error('Frozen checkout base is invalid');
      const customer = await trx
        .selectFrom('payer_profiles')
        .select('stripe_customer_id')
        .where('account_id', '=', input.accountId)
        .executeTakeFirst();
      const account = await trx
        .selectFrom('payment_accounts')
        .select('stripe_account_id')
        .where('org_id', '=', input.orgId)
        .executeTakeFirst();
      if (!customer?.stripe_customer_id || !account?.stripe_account_id)
        throw new Error('Stripe payer or connected account is unavailable');
      const authorization = await trx
        .selectFrom('autopay_authorizations')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', input.accountId)
        .where('invoice_id', '=', input.invoiceId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      const charge: FrozenCharge = {
        orgId: input.orgId,
        checkoutId: input.checkoutId,
        invoiceId: input.invoiceId,
        accountId: input.accountId,
        customerId: customer.stripe_customer_id,
        connectedAccountId: account.stripe_account_id,
        version: checkout.version,
        baseCents,
        taxCents: snapshot.taxCents,
        applicationRate: snapshot.paymentTerms.applicationRate,
        serviceFee:
          snapshot.paymentTerms.serviceFee.enabled &&
          snapshot.paymentTerms.serviceFee.mode === 'cover_costs'
            ? {
                enabled: true,
                mode: 'cover_costs',
                ...(snapshot.paymentTerms.serviceFee.processing
                  ? { processing: snapshot.paymentTerms.serviceFee.processing }
                  : {}),
              }
            : snapshot.paymentTerms.serviceFee,
        autopayAuthorized: Boolean(authorization),
        ...(snapshot.paymentTerms.statementDescriptorSuffix
          ? {
              statementDescriptorSuffix:
                snapshot.paymentTerms.statementDescriptorSuffix,
            }
          : {}),
      };
      const quote = quoteCharge(charge);
      if (
        quote.serviceFeeCents !== snapshot.serviceFeeCents ||
        quote.amountCents !== snapshot.chargeNowCents
      )
        throw new Error('Frozen checkout fees do not reconcile');
      return charge;
    });
  }
}
