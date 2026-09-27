import { expect, it, vi } from 'vitest';

import { stripeEventFixture } from '../../integrations/stripe/webhook-fixtures.js';

import { BillingInvoiceEventService } from './billing-invoice-events.js';

it('syncs the latest subscription before applying its latest paid invoice', async () => {
  const order: string[] = [];
  const orgId = '01a0e289-9bc5-75cd-b558-f557551aea96';
  const invoice = {
    id: 'in_test_paid',
    customerId: 'cus_test',
    subscriptionId: 'sub_test',
    status: 'paid',
    currency: 'usd',
    totalCents: 2500,
    amountPaidCents: 2500,
    amountDueCents: 0,
    created: 1_800_000_000,
  };
  const subscription = {
    id: 'sub_test',
    orgId,
    customerId: 'cus_test',
    priceIds: ['price_test'],
    status: 'active',
    currentPeriodEnd: 1_900_000_000,
  };
  const service = new BillingInvoiceEventService(
    {
      retrieveBillingInvoice: vi.fn().mockResolvedValue(invoice),
      retrieveBillingSubscription: vi.fn().mockResolvedValue(subscription),
    },
    () => {
      order.push('subscription');
      return Promise.resolve();
    },
    () => {
      order.push('invoice');
      return Promise.resolve();
    },
  );
  await service.handle({
    ...stripeEventFixture('invoice.paid'),
    data: { object: { id: invoice.id, object: 'invoice' } },
  });
  expect(order).toEqual(['subscription', 'invoice']);
});
