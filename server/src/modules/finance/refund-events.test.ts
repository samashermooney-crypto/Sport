import { describe, expect, it, vi } from 'vitest';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { parseStripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

import {
  RefundEventService,
  type RefundEventRepository,
} from './refund-events.js';

function event(type: string, id: string, object: string) {
  return parseStripeWebhookEvent({
    id: 'evt_refund_test',
    object: 'event',
    type,
    livemode: false,
    created: 1_700_000_000,
    data: { object: { id, object } },
  });
}

function harness() {
  const refund = {
    id: 're_test_1',
    status: 'succeeded',
    amountCents: 500,
    paymentIntentId: 'pi_test_1',
    orgId: null,
  };
  const repository = {
    applyLatest: vi.fn<RefundEventRepository['applyLatest']>(() =>
      Promise.resolve('applied'),
    ),
  };
  const gateway = {
    retrieveRefund: vi.fn<PaymentsGateway['retrieveRefund']>(() =>
      Promise.resolve(refund),
    ),
    listRefundsForCharge: vi.fn<PaymentsGateway['listRefundsForCharge']>(() =>
      Promise.resolve([refund]),
    ),
    retrievePaymentIntent: vi.fn<PaymentsGateway['retrievePaymentIntent']>(() =>
      Promise.resolve({
        id: 'pi_test_1',
        clientSecret: null,
        status: 'succeeded',
        amountCents: 1000,
        latestChargeId: 'ch_test_1',
        orgId: 'org-test',
      }),
    ),
  };
  return {
    service: new RefundEventService(repository, gateway),
    repository,
    gateway,
  };
}

describe('Stripe refund webhook latest state', () => {
  it('resolves a refund org from the PaymentIntent when metadata is absent', async () => {
    const { service, repository } = harness();
    await service.handle(event('charge.refund.updated', 're_test_1', 'refund'));
    expect(repository.applyLatest.mock.calls[0]?.[0].orgId).toBe('org-test');
    expect(repository.applyLatest.mock.calls[0]?.[0].refund.id).toBe(
      're_test_1',
    );
  });

  it('lists current refunds when the charge event arrives out of order', async () => {
    const { service, gateway, repository } = harness();
    await service.handle(event('charge.refunded', 'ch_test_1', 'charge'));
    expect(gateway.listRefundsForCharge).toHaveBeenCalledWith('ch_test_1');
    expect(repository.applyLatest).toHaveBeenCalledOnce();
  });
});
