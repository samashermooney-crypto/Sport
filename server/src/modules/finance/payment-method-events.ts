import { z } from 'zod';

import type { StripeEventHandlers } from '../../integrations/stripe/dispatch.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import type { StripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

import type {
  PayerProfileRepository,
  SavedPaymentMethodRepository,
} from './payer-methods.js';

const setupObject = z.object({
  id: z.string().startsWith('seti_'),
  object: z.literal('setup_intent'),
});
const methodObject = z.object({
  id: z.string().startsWith('pm_'),
  object: z.literal('payment_method'),
});

/** Uses current Stripe state so a delayed webhook cannot resurrect a detached method. */
export class PaymentMethodEventService {
  constructor(
    private readonly profiles: Pick<
      PayerProfileRepository,
      'findAccountByCustomer' | 'load'
    >,
    private readonly methods: SavedPaymentMethodRepository,
    private readonly gateway: Pick<
      PaymentsGateway,
      'retrieveSetupIntent' | 'retrievePaymentMethod'
    >,
  ) {}

  async handle(event: StripeWebhookEvent): Promise<void> {
    if (event.type === 'setup_intent.succeeded') {
      const payload = setupObject.parse(event.data.object);
      const latest = await this.gateway.retrieveSetupIntent(payload.id);
      if (latest.id !== payload.id)
        throw new Error('Stripe returned a different SetupIntent');
      if (latest.status !== 'succeeded') return;
      if (!latest.customerId || !latest.paymentMethodId)
        throw new Error('Successful SetupIntent lacks Customer or method');
      const accountId = await this.profiles.findAccountByCustomer(
        latest.customerId,
      );
      if (!accountId)
        throw new Error('SetupIntent Customer has no payer profile');
      const method = await this.gateway.retrievePaymentMethod(
        latest.paymentMethodId,
      );
      if (method.id !== latest.paymentMethodId)
        throw new Error('Stripe returned a different payment method');
      if (method.customerId === null) {
        const owner = await this.methods.findOwner(method.id);
        if (owner === accountId)
          await this.methods.markDetached(accountId, method.id);
        return;
      }
      if (method.customerId !== latest.customerId)
        throw new Error('SetupIntent method is attached to another Customer');
      await this.methods.sync(accountId, [method]);
      return;
    }
    if (event.type === 'payment_method.detached') {
      const payload = methodObject.parse(event.data.object);
      const accountId = await this.methods.findOwner(payload.id);
      if (!accountId)
        throw new Error('Detached Stripe method has no local owner');
      const latest = await this.gateway.retrievePaymentMethod(payload.id);
      if (latest.id !== payload.id)
        throw new Error('Stripe returned a different payment method');
      if (latest.customerId === null) {
        await this.methods.markDetached(accountId, payload.id);
        return;
      }
      const customerId = await this.profiles.load(accountId);
      if (latest.customerId !== customerId)
        throw new Error('Stripe method is attached to another payer');
      await this.methods.sync(accountId, [latest]);
      return;
    }
    throw new Error('Expected a saved-payment-method event');
  }
}

export function paymentMethodHandlers(
  service: PaymentMethodEventService,
): StripeEventHandlers {
  return {
    'setup_intent.succeeded': (event) => service.handle(event),
    'payment_method.detached': (event) => service.handle(event),
  };
}
