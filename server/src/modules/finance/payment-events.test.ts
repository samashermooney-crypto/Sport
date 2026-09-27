import { describe, expect, it, vi } from 'vitest';

import { parseStripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

import {
  PaymentIntentEventService,
  type PaymentEventRepository,
} from './payment-events.js';

const orgId = '01234567-89ab-4cde-8f01-234567890abc';

function event(type: string, intentId = 'pi_test_1') {
  return parseStripeWebhookEvent({
    id: 'evt_test_1',
    object: 'event',
    type,
    livemode: false,
    created: 1,
    data: {
      object: {
        id: intentId,
        object: 'payment_intent',
        metadata: { org_id: orgId },
      },
    },
  });
}

describe('PaymentIntent event service', () => {
  it('uses the latest Stripe state for stale and duplicate events', async () => {
    const applied: string[] = [];
    const repository: PaymentEventRepository = {
      applyLatest: vi.fn<PaymentEventRepository['applyLatest']>((input) => {
        expect(input.orgId).toBe(orgId);
        expect(input.paymentIntentId).toBe('pi_test_1');
        if (applied.includes(input.latest.status)) {
          return Promise.resolve('unchanged' as const);
        }
        applied.push(input.latest.status);
        return Promise.resolve('applied' as const);
      }),
    };
    const gateway = {
      retrievePaymentIntent: vi.fn(() =>
        Promise.resolve({
          id: 'pi_test_1',
          clientSecret: null,
          status: 'succeeded',
          amountCents: 1000,
          latestChargeId: 'ch_test_1',
        }),
      ),
    };
    const service = new PaymentIntentEventService(repository, gateway);
    await expect(
      service.handle(event('payment_intent.processing')),
    ).resolves.toBe('applied');
    await expect(
      service.handle(event('payment_intent.succeeded')),
    ).resolves.toBe('unchanged');
    expect(gateway.retrievePaymentIntent).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(['succeeded']);
  });

  it('rejects missing org metadata and a mismatched retrieved intent', async () => {
    const repository = {
      applyLatest: vi.fn(() => Promise.resolve('applied' as const)),
    };
    const gateway = {
      retrievePaymentIntent: vi.fn(() =>
        Promise.resolve({
          id: 'pi_other',
          clientSecret: null,
          status: 'processing',
          amountCents: 1000,
          latestChargeId: null,
        }),
      ),
    };
    const service = new PaymentIntentEventService(repository, gateway);
    await expect(
      service.handle(event('payment_intent.processing')),
    ).rejects.toThrow('different PaymentIntent');
    const malformed = event('payment_intent.succeeded');
    malformed.data.object.metadata = {};
    await expect(service.handle(malformed)).rejects.toThrow();
    expect(repository.applyLatest).not.toHaveBeenCalled();
  });
});
