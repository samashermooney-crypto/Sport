import { z } from 'zod';

import type { StripeEventHandlers } from '../../integrations/stripe/dispatch.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import type { StripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

import type { BillingSubscription } from './org-billing.js';

const subscriptionObject = z.object({
  id: z.string().startsWith('sub_'),
  object: z.literal('subscription'),
});

export class BillingSubscriptionEventService {
  constructor(
    private readonly gateway: Pick<
      PaymentsGateway,
      'retrieveBillingSubscription'
    >,
    private readonly sync: (
      orgId: string,
      latest: BillingSubscription,
    ) => Promise<void>,
  ) {}

  async handle(event: StripeWebhookEvent): Promise<void> {
    if (!event.type.startsWith('customer.subscription.') || event.account)
      throw new Error('Expected a platform subscription event');
    const payload = subscriptionObject.parse(event.data.object);
    const latest = await this.gateway.retrieveBillingSubscription(payload.id);
    if (latest.id !== payload.id)
      throw new Error('Stripe returned another subscription');
    const orgId = z.uuid().parse(latest.orgId);
    await this.sync(orgId, latest);
  }
}

export function billingSubscriptionHandlers(
  service: BillingSubscriptionEventService,
): StripeEventHandlers {
  const handle = (event: StripeWebhookEvent) => service.handle(event);
  return {
    'customer.subscription.created': handle,
    'customer.subscription.updated': handle,
    'customer.subscription.deleted': handle,
  };
}
