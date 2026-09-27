import { z } from 'zod';

import type { StripeEventHandlers } from '../../integrations/stripe/dispatch.js';
import type {
  GatewayRefund,
  PaymentsGateway,
} from '../../integrations/stripe/gateway.js';
import type { StripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

const refundObject = z.object({
  id: z.string().startsWith('re_'),
  object: z.literal('refund'),
});
const chargeObject = z.object({
  id: z.string().startsWith('ch_'),
  object: z.literal('charge'),
});

export interface RefundEventRepository {
  applyLatest(input: {
    orgId: string;
    refund: GatewayRefund;
  }): Promise<'applied' | 'unchanged'>;
}

/** Latest Stripe refund state wins over webhook delivery order. */
export class RefundEventService {
  constructor(
    private readonly repository: RefundEventRepository,
    private readonly gateway: Pick<
      PaymentsGateway,
      'retrieveRefund' | 'listRefundsForCharge' | 'retrievePaymentIntent'
    >,
  ) {}

  async handle(event: StripeWebhookEvent): Promise<void> {
    let refunds: GatewayRefund[];
    if (event.type === 'charge.refund.updated') {
      const payload = refundObject.parse(event.data.object);
      refunds = [await this.gateway.retrieveRefund(payload.id)];
      if (refunds[0]?.id !== payload.id)
        throw new Error('Stripe returned a different refund');
    } else if (event.type === 'charge.refunded') {
      const payload = chargeObject.parse(event.data.object);
      refunds = await this.gateway.listRefundsForCharge(payload.id);
    } else {
      throw new Error('Expected a Stripe refund event');
    }
    for (const refund of refunds) {
      if (!refund.id.startsWith('re_'))
        throw new Error('Invalid Stripe refund ID');
      let orgId = refund.orgId;
      if (!orgId) {
        if (!refund.paymentIntentId)
          throw new Error('Refund has no organization or PaymentIntent');
        const payment = await this.gateway.retrievePaymentIntent(
          refund.paymentIntentId,
        );
        if (payment.id !== refund.paymentIntentId)
          throw new Error('Stripe returned a different PaymentIntent');
        orgId = payment.orgId ?? null;
      }
      if (!orgId) throw new Error('Refund organization cannot be resolved');
      await this.repository.applyLatest({ orgId, refund });
    }
  }
}

export function refundHandlers(
  service: RefundEventService,
): StripeEventHandlers {
  return {
    'charge.refunded': (event) => service.handle(event),
    'charge.refund.updated': (event) => service.handle(event),
  };
}
