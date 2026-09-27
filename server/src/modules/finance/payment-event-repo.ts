import { Temporal } from '@js-temporal/polyfill';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { GatewayPaymentIntent } from '../../integrations/stripe/gateway.js';
import { appendAuditEvent } from '../audit/service.js';

import { recomputeInvoiceStatus } from './invoice-repo.js';
import type {
  PaymentEventRepository,
  PaymentEventResult,
} from './payment-events.js';

type StoredStatus =
  'requires_action' | 'processing' | 'succeeded' | 'failed' | 'canceled';

function storedStatus(stripeStatus: string): StoredStatus {
  switch (stripeStatus) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
      return 'processing';
    case 'canceled':
      return 'canceled';
    case 'requires_payment_method':
      return 'failed';
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_capture':
      return 'requires_action';
    default:
      throw new Error(
        `Unsupported Stripe PaymentIntent status: ${stripeStatus}`,
      );
  }
}

/** Applies the current Stripe intent state while holding the payment and invoice rows. */
export class PostgresPaymentEventRepository implements PaymentEventRepository {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly actorAccountId: string,
    private readonly now: () => Temporal.Instant = () => Temporal.Now.instant(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async applyLatest(input: {
    orgId: string;
    paymentIntentId: string;
    latest: GatewayPaymentIntent;
  }): Promise<PaymentEventResult> {
    if (input.latest.id !== input.paymentIntentId)
      throw new Error('Stripe PaymentIntent ID mismatch');
    const target = storedStatus(input.latest.status);
    const context: OrgContext = {
      orgId: input.orgId,
      actor: { accountId: this.actorAccountId },
    };
    return this.withOrg(context, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select(['id', 'amount_cents', 'status', 'method', 'stripe_charge_id'])
        .select(
          sql<Date | null>`processing_started_at`.as('processing_started_at'),
        )
        .where('org_id', '=', input.orgId)
        .where('stripe_payment_intent_id', '=', input.paymentIntentId)
        .forUpdate()
        .executeTakeFirst();
      if (!payment)
        throw new Error('Stripe PaymentIntent has no payment record');
      if (payment.amount_cents !== input.latest.amountCents)
        throw new Error(
          'Stripe PaymentIntent amount differs from recorded payment',
        );
      if (payment.status === 'succeeded' && target !== 'succeeded')
        throw new Error('A successful Stripe payment cannot regress');
      if (payment.status === 'canceled' && target !== 'canceled')
        throw new Error('A canceled Stripe payment cannot change status');
      const allocations = await trx
        .selectFrom('payment_allocations')
        .select(['invoice_id', 'installment_id', 'amount_cents'])
        .where('org_id', '=', input.orgId)
        .where('payment_id', '=', payment.id)
        .execute();
      if (
        allocations.length !== 1 ||
        allocations[0]?.amount_cents !== payment.amount_cents
      ) {
        throw new Error('Payment allocation does not reconcile');
      }
      const allocation = allocations[0];
      const method = input.latest.method ?? payment.method;
      if (target === 'succeeded' && method === 'unknown')
        throw new Error('Successful Stripe payment method is unknown');
      const chargeId = input.latest.latestChargeId ?? payment.stripe_charge_id;
      if (
        target === payment.status &&
        method === payment.method &&
        chargeId === payment.stripe_charge_id
      )
        return 'unchanged';

      const org = await trx
        .selectFrom('organizations')
        .select('timezone')
        .where('id', '=', input.orgId)
        .executeTakeFirstOrThrow();
      const todayLocal = this.now()
        .toZonedDateTimeISO(org.timezone)
        .toPlainDate()
        .toString();
      const firstSuccess =
        target === 'succeeded' && payment.status !== 'succeeded';
      const firstProcessing =
        target === 'processing' && payment.processing_started_at === null;
      await trx
        .updateTable('payments')
        .set({
          status: target,
          method,
          stripe_charge_id: chargeId,
          succeeded_at: firstSuccess
            ? new Date(this.now().epochMilliseconds)
            : undefined,
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', payment.id)
        .execute();
      if (firstProcessing) {
        await sql`
          UPDATE payments SET processing_started_at = ${new Date(this.now().epochMilliseconds)}
          WHERE org_id = ${input.orgId}::uuid AND id = ${payment.id}::uuid
        `.execute(trx);
      }
      if (firstSuccess) {
        await trx
          .updateTable('invoices')
          .set({
            paid_cents: sql`paid_cents + ${allocation.amount_cents}`,
            version: sql`version + 1`,
          })
          .where('org_id', '=', input.orgId)
          .where('id', '=', allocation.invoice_id)
          .execute();
        if (allocation.installment_id) {
          await trx
            .updateTable('installments')
            .set({ paid_cents: sql`paid_cents + ${allocation.amount_cents}` })
            .where('org_id', '=', input.orgId)
            .where('id', '=', allocation.installment_id)
            .execute();
        }
        await recomputeInvoiceStatus(
          trx,
          input.orgId,
          allocation.invoice_id,
          todayLocal,
        );
      }
      await appendAuditEvent(trx, context, {
        action: `payment.${target}`,
        entityType: 'payment',
        entityId: payment.id,
        changes: {
          status: { tier: 'internal', before: payment.status, after: target },
        },
      });
      return 'applied';
    });
  }
}
