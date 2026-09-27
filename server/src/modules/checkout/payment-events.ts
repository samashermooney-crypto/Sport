import { Temporal } from '@js-temporal/polyfill';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import type { CheckoutCapacityRepository, CheckoutService } from './service.js';

const moneySettings = z.looseObject({
  confirmOnAchProcessing: z.boolean().optional(),
});

export interface CheckoutPaymentEventInput {
  orgId: string;
  paymentIntentId: string;
  status: string;
  amountCents: number;
  method: string | null;
}

/** Runs after payment settlement; retry the Stripe event until this stage completes. */
export class CheckoutPaymentEventService {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly actorAccountId: string,
    private readonly capacity: Pick<CheckoutCapacityRepository, 'confirm'>,
    private readonly transitions: Pick<
      CheckoutService,
      'confirmPaidCheckout' | 'failPayment'
    >,
    private readonly now: () => Temporal.Instant = () => Temporal.Now.instant(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async applyLatest(input: CheckoutPaymentEventInput): Promise<void> {
    const context: OrgContext = {
      orgId: input.orgId,
      actor: { accountId: this.actorAccountId },
    };
    const snapshot = await this.withOrg(context, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select(['status', 'amount_cents'])
        .select(sql<string | null>`checkout_id`.as('checkout_id'))
        .select(
          sql<Date | null>`processing_started_at`.as('processing_started_at'),
        )
        .where('org_id', '=', input.orgId)
        .where('stripe_payment_intent_id', '=', input.paymentIntentId)
        .executeTakeFirst();
      if (!payment || payment.amount_cents !== input.amountCents)
        throw new Error('Checkout event payment is unavailable or mismatched');
      if (!payment.checkout_id) return null;
      const checkout = await trx
        .selectFrom('checkouts')
        .select('status')
        .where('org_id', '=', input.orgId)
        .where('id', '=', payment.checkout_id)
        .executeTakeFirst();
      if (!checkout) throw new Error('Checkout event has no checkout');
      const holds = await trx
        .selectFrom('capacity_holds')
        .select('expires_at')
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', payment.checkout_id)
        .execute();
      if (!holds.length) return null;
      const org = await trx
        .selectFrom('organizations')
        .select('settings')
        .where('id', '=', input.orgId)
        .executeTakeFirstOrThrow();
      const settings = moneySettings.parse(org.settings);
      return {
        checkoutId: payment.checkout_id,
        checkoutStatus: checkout.status,
        paymentStatus: payment.status,
        processingStartedAt:
          payment.processing_started_at?.toISOString() ?? null,
        holdExpiresAt: new Date(
          Math.min(...holds.map((hold) => hold.expires_at.getTime())),
        ).toISOString(),
        confirmOnAchProcessing: settings.confirmOnAchProcessing ?? true,
      };
    });
    if (!snapshot) return;
    if (
      snapshot.paymentStatus !== input.status &&
      !(
        input.status === 'requires_payment_method' &&
        snapshot.paymentStatus === 'failed'
      )
    )
      throw new Error('Checkout event status differs from settled payment');
    if (input.status === 'processing') {
      if (
        !snapshot.confirmOnAchProcessing ||
        input.method !== 'us_bank_account'
      )
        return;
      const processingAt = snapshot.processingStartedAt;
      if (!processingAt)
        throw new Error('ACH processing start was not recorded');
      const honorProcessingHold =
        Temporal.Instant.compare(
          Temporal.Instant.from(processingAt),
          Temporal.Instant.from(snapshot.holdExpiresAt),
        ) <= 0;
      await this.capacity.confirm({
        orgId: input.orgId,
        checkoutId: snapshot.checkoutId,
        honorProcessingHold,
      });
      return;
    }
    if (input.status === 'succeeded') {
      await this.transitions.confirmPaidCheckout({
        orgId: input.orgId,
        checkoutId: snapshot.checkoutId,
        checkoutStatus: snapshot.checkoutStatus,
        processingStartedAt: snapshot.processingStartedAt,
        holdExpiresAt: snapshot.holdExpiresAt,
        paymentIntentId: input.paymentIntentId,
        amountCents: input.amountCents,
      });
      return;
    }
    if (
      input.status === 'requires_payment_method' ||
      input.status === 'canceled'
    ) {
      await this.transitions.failPayment({
        orgId: input.orgId,
        checkoutId: snapshot.checkoutId,
        failedAt: this.now().toString(),
      });
    }
  }
}
