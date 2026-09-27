import { serviceFee, type ServiceFeeConfig } from '@shared/algorithms/fees';
import type { PricingInput, PricingSnapshot } from '@shared/algorithms/pricing';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';
import { frozenPaymentTermsSchema } from '../finance/frozen-charge-repo.js';

import {
  assertPricingSnapshot,
  type CheckoutPricingRepository,
  type FrozenCheckoutPricing,
} from './pricing.js';

export interface CheckoutPricingSourceLoader {
  /** Lock every offering, discount, aid and credit source inside this transaction. */
  load(
    trx: OrgTransaction,
    checkout: {
      orgId: string;
      checkoutId: string;
      accountId: string;
      items: Json;
    },
  ): Promise<{
    pricing: PricingInput;
    paymentTerms: z.output<typeof frozenPaymentTermsSchema>;
  }>;
}

const storedSnapshotSchema = z.object({
  lines: z.array(
    z.object({
      id: z.string(),
      kind: z.enum([
        'participant',
        'add_on',
        'discount',
        'aid',
        'service_fee',
        'tax',
      ]),
      amountCents: z.number().int(),
      parentLineId: z.string().optional(),
      sourceId: z.string().optional(),
      taxable: z.boolean(),
    }),
  ),
  subtotalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  aidCents: z.number().int().nonnegative(),
  creditAppliedCents: z.number().int().nonnegative(),
  serviceFeeCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  invoiceTotalCents: z.number().int().nonnegative(),
  chargeNowCents: z.number().int().nonnegative(),
  sourceVersion: z.number().int().positive(),
  paymentTerms: frozenPaymentTermsSchema,
});

function serviceFeeConfig(
  terms: z.output<typeof frozenPaymentTermsSchema>,
): ServiceFeeConfig {
  if (!terms.serviceFee.enabled) return { enabled: false };
  if (terms.serviceFee.mode === 'custom')
    return { enabled: true, mode: 'custom', custom: terms.serviceFee.custom };
  return {
    enabled: true,
    mode: 'cover_costs',
    application: terms.applicationRate,
    ...(terms.serviceFee.processing
      ? { processing: terms.serviceFee.processing }
      : {}),
  };
}

function canonicalSnapshot(snapshot: PricingSnapshot): PricingSnapshot {
  const zero = (value: number): number => (value === 0 ? 0 : value);
  return {
    ...snapshot,
    lines: snapshot.lines.map((line) => ({
      ...line,
      amountCents: zero(line.amountCents),
    })),
    subtotalCents: zero(snapshot.subtotalCents),
    discountCents: zero(snapshot.discountCents),
    aidCents: zero(snapshot.aidCents),
    creditAppliedCents: zero(snapshot.creditAppliedCents),
    serviceFeeCents: zero(snapshot.serviceFeeCents),
    taxCents: zero(snapshot.taxCents),
    invoiceTotalCents: zero(snapshot.invoiceTotalCents),
    chargeNowCents: zero(snapshot.chargeNowCents),
  };
}

/** Freezes the database-owned quote and fee terms before any PaymentIntent. */
export class PostgresCheckoutPricingRepository implements CheckoutPricingRepository {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly sources: CheckoutPricingSourceLoader,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async freeze(input: {
    orgId: string;
    checkoutId: string;
    idempotencyKey: string;
    calculate: (source: PricingInput) => PricingSnapshot;
  }): Promise<FrozenCheckoutPricing> {
    if (input.orgId !== this.context.orgId)
      throw new Error('Checkout pricing organization mismatch');
    const key = z.uuid().parse(input.idempotencyKey);
    return this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select([
          'account_id',
          'status',
          'expires_at',
          'items',
          'pricing_snapshot',
          'idempotency_key',
          'version',
        ])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !checkout ||
        checkout.account_id !== this.context.actor.accountId ||
        checkout.expires_at.getTime() <= Date.now()
      )
        throw new Error('Checkout pricing source is unavailable');
      if (checkout.status === 'awaiting_payment') {
        if (checkout.idempotency_key !== key)
          throw new Error(
            'Checkout pricing is already frozen with another key',
          );
        const stored = storedSnapshotSchema.parse(checkout.pricing_snapshot);
        const snapshot: PricingSnapshot = {
          lines: stored.lines.map((line) => ({
            id: line.id,
            kind: line.kind,
            amountCents: line.amountCents,
            taxable: line.taxable,
            ...(line.parentLineId ? { parentLineId: line.parentLineId } : {}),
            ...(line.sourceId ? { sourceId: line.sourceId } : {}),
          })),
          subtotalCents: stored.subtotalCents,
          discountCents: stored.discountCents,
          aidCents: stored.aidCents,
          creditAppliedCents: stored.creditAppliedCents,
          serviceFeeCents: stored.serviceFeeCents,
          taxCents: stored.taxCents,
          invoiceTotalCents: stored.invoiceTotalCents,
          chargeNowCents: stored.chargeNowCents,
        };
        assertPricingSnapshot(snapshot);
        return {
          orgId: input.orgId,
          checkoutId: input.checkoutId,
          sourceVersion: stored.sourceVersion,
          snapshot,
        };
      }
      if (checkout.status !== 'open')
        throw new Error('Checkout pricing source is unavailable');
      const source = await this.sources.load(trx, {
        orgId: input.orgId,
        checkoutId: input.checkoutId,
        accountId: checkout.account_id,
        items: checkout.items,
      });
      const terms = frozenPaymentTermsSchema.parse(source.paymentTerms);
      const snapshot = canonicalSnapshot(input.calculate(source.pricing));
      assertPricingSnapshot(snapshot);
      const baseCents =
        snapshot.subtotalCents -
        snapshot.discountCents -
        snapshot.aidCents -
        snapshot.creditAppliedCents;
      if (
        !Number.isSafeInteger(baseCents) ||
        baseCents < 0 ||
        serviceFee(baseCents, serviceFeeConfig(terms)) !==
          snapshot.serviceFeeCents
      )
        throw new Error('Frozen service fee differs from pricing sources');
      const stored = {
        ...snapshot,
        paymentTerms: terms,
        sourceVersion: checkout.version,
      };
      await trx
        .updateTable('checkouts')
        .set({
          pricing_snapshot: stored as Json,
          idempotency_key: key,
          status: 'awaiting_payment',
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'checkout.pricing_frozen',
        entityType: 'checkout',
        entityId: input.checkoutId,
        changes: {
          chargeNowCents: { tier: 'internal', after: snapshot.chargeNowCents },
        },
      });
      return {
        orgId: input.orgId,
        checkoutId: input.checkoutId,
        sourceVersion: checkout.version,
        snapshot,
      };
    });
  }
}
