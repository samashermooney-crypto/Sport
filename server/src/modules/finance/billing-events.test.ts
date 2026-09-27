import { expect, it, vi } from 'vitest';

import { stripeEventFixture } from '../../integrations/stripe/webhook-fixtures.js';

import { BillingSubscriptionEventService } from './billing-events.js';

it('fetches the latest platform subscription before applying a webhook hint', async () => {
  const latest = {
    id: 'sub_fixture',
    orgId: '01a0e289-9bc5-75cd-b558-f557551aea96',
    customerId: 'cus_fixture',
    priceIds: ['price_fixture'],
    status: 'active',
    currentPeriodEnd: 1_900_000_000,
  };
  const retrieveBillingSubscription = vi.fn().mockResolvedValue(latest);
  const sync = vi.fn().mockResolvedValue(undefined);
  const service = new BillingSubscriptionEventService(
    { retrieveBillingSubscription },
    sync,
  );
  const event = {
    ...stripeEventFixture('customer.subscription.updated'),
    data: { object: { id: 'sub_fixture', object: 'subscription' } },
  };
  await service.handle(event);
  expect(retrieveBillingSubscription).toHaveBeenCalledWith('sub_fixture');
  expect(sync).toHaveBeenCalledWith(latest.orgId, latest);
  await expect(
    service.handle({
      ...event,
      account: 'acct_other',
    }),
  ).rejects.toThrow('platform subscription');
});
