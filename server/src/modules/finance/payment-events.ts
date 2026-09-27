import { z } from 'zod';

import type { StripeEventHandlers } from '../../integrations/stripe/dispatch.js';
import type {
  GatewayPaymentIntent,
  PaymentsGateway,
} from '../../integrations/stripe/gateway.js';
import type { StripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

const paymentObject = z.object({
  id: z.string().startsWith('pi_'),
  object: z.literal('payment_intent'),
  metadata: z.object({ org_id: z.uuid() }),
});

export type PaymentEventResult = 'applied' | 'unchanged';

/**
 * applyLatest runs inside withOrg and matches the stored intent ID and amount.
 * It atomically updates payment, allocations, invoice, installment, checkout,
 * capacity and audit state. Duplicate and older statuses do not double-apply
 * money. ACH failure after processing reverses any provisional allocation.
 * An unknown intent throws so the event remains retryable and visible.
 */
export interface PaymentEventRepository {
  applyLatest(input: {
    orgId: string;
    paymentIntentId: string;
    latest: GatewayPaymentIntent;
  }): Promise<PaymentEventResult>;
}

export class PaymentIntentEventService {
  constructor(
    private readonly repository: PaymentEventRepository,
    private readonly gateway: Pick<PaymentsGateway, 'retrievePaymentIntent'>,
  ) {}

  async handle(event: StripeWebhookEvent): Promise<PaymentEventResult> {
    if (!event.type.startsWith('payment_intent.')) {
      throw new Error('Expected a PaymentIntent event');
    }
    const payment = paymentObject.parse(event.data.object);
    const latest = await this.gateway.retrievePaymentIntent(payment.id);
    if (latest.id !== payment.id) {
      throw new Error('Stripe returned a different PaymentIntent');
    }
    return this.repository.applyLatest({
      orgId: payment.metadata.org_id,
      paymentIntentId: payment.id,
      latest,
    });
  }
}

export function paymentIntentHandlers(
  service: PaymentIntentEventService,
): StripeEventHandlers {
  const handle = async (event: StripeWebhookEvent): Promise<void> => {
    await service.handle(event);
  };
  return {
    'payment_intent.succeeded': handle,
    'payment_intent.processing': handle,
    'payment_intent.payment_failed': handle,
    'payment_intent.canceled': handle,
    'payment_intent.requires_action': handle,
  };
}
