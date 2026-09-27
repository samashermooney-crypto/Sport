import { z } from 'zod';

import type { StripeEventHandlers } from '../../integrations/stripe/dispatch.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import type { StripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

import type { BillingInvoice } from './billing-invoices.js';
import type { BillingSubscription } from './org-billing.js';

const invoiceObject = z.object({
  id: z.string().startsWith('in_'),
  object: z.literal('invoice'),
});

/** Invoice webhooks are hints; the latest subscription is synced first. */
export class BillingInvoiceEventService {
  constructor(
    private readonly gateway: Pick<
      PaymentsGateway,
      'retrieveBillingInvoice' | 'retrieveBillingSubscription'
    >,
    private readonly syncSubscription: (
      orgId: string,
      latest: BillingSubscription,
    ) => Promise<void>,
    private readonly syncInvoice: (
      orgId: string,
      latest: BillingInvoice,
    ) => Promise<void>,
  ) {}

  async handle(event: StripeWebhookEvent): Promise<void> {
    if (!event.type.startsWith('invoice.') || event.account)
      throw new Error('Expected a platform Billing invoice event');
    const payload = invoiceObject.parse(event.data.object);
    const invoice = await this.gateway.retrieveBillingInvoice(payload.id);
    if (invoice.id !== payload.id)
      throw new Error('Stripe returned another invoice');
    if (!invoice.subscriptionId) return;
    const subscription = await this.gateway.retrieveBillingSubscription(
      invoice.subscriptionId,
    );
    if (
      subscription.id !== invoice.subscriptionId ||
      subscription.customerId !== invoice.customerId
    )
      throw new Error('Billing invoice and subscription disagree');
    const orgId = z.uuid().parse(subscription.orgId);
    await this.syncSubscription(orgId, subscription);
    await this.syncInvoice(orgId, invoice);
  }
}

export function billingInvoiceHandlers(
  service: BillingInvoiceEventService,
): StripeEventHandlers {
  const handle = (event: StripeWebhookEvent) => service.handle(event);
  return {
    'invoice.created': handle,
    'invoice.updated': handle,
    'invoice.finalized': handle,
    'invoice.paid': handle,
    'invoice.payment_failed': handle,
    'invoice.voided': handle,
  };
}
