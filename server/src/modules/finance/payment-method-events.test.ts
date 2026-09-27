import { describe, expect, it, vi } from 'vitest';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { parseStripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

import type {
  PayerProfileRepository,
  SavedPaymentMethodRepository,
} from './payer-methods.js';
import { PaymentMethodEventService } from './payment-method-events.js';

function event(type: string, id: string, object: string) {
  return parseStripeWebhookEvent({
    id: `evt_${type.replaceAll('.', '_')}`,
    object: 'event',
    type,
    livemode: false,
    created: 1_700_000_000,
    data: { object: { id, object } },
  });
}

function harness() {
  const profiles = {
    findAccountByCustomer: vi.fn<
      Pick<
        PayerProfileRepository,
        'findAccountByCustomer'
      >['findAccountByCustomer']
    >(() => Promise.resolve('acct-local')),
    load: vi.fn<Pick<PayerProfileRepository, 'load'>['load']>(() =>
      Promise.resolve('cus_test_1'),
    ),
  };
  const methods = {
    sync: vi.fn<SavedPaymentMethodRepository['sync']>(() => Promise.resolve()),
    markDetached: vi.fn<SavedPaymentMethodRepository['markDetached']>(() =>
      Promise.resolve(),
    ),
    findOwner: vi.fn<SavedPaymentMethodRepository['findOwner']>(() =>
      Promise.resolve('acct-local'),
    ),
    setDefault: vi.fn<SavedPaymentMethodRepository['setDefault']>(() =>
      Promise.resolve(),
    ),
  };
  const gateway = {
    retrieveSetupIntent: vi.fn<PaymentsGateway['retrieveSetupIntent']>(() =>
      Promise.resolve({
        id: 'seti_test_1',
        status: 'succeeded',
        customerId: 'cus_test_1',
        paymentMethodId: 'pm_test_1',
      }),
    ),
    retrievePaymentMethod: vi.fn<PaymentsGateway['retrievePaymentMethod']>(() =>
      Promise.resolve({
        id: 'pm_test_1',
        type: 'card',
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2030,
        bankName: null,
        customerId: 'cus_test_1',
      }),
    ),
  };
  return {
    service: new PaymentMethodEventService(profiles, methods, gateway),
    profiles,
    methods,
    gateway,
  };
}

describe('saved method webhooks', () => {
  it('syncs a successful SetupIntent only when the method is attached to its payer', async () => {
    const { service, methods, gateway } = harness();
    const payload = event(
      'setup_intent.succeeded',
      'seti_test_1',
      'setup_intent',
    );
    await service.handle(payload);
    expect(methods.sync).toHaveBeenCalledWith('acct-local', [
      expect.objectContaining({ id: 'pm_test_1' }),
    ]);
    gateway.retrievePaymentMethod.mockResolvedValueOnce({
      id: 'pm_test_1',
      type: 'card',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      bankName: null,
      customerId: 'cus_other',
    });
    await expect(service.handle(payload)).rejects.toThrow('another Customer');
  });

  it('uses latest attachment state for a delayed detach event', async () => {
    const { service, methods, gateway } = harness();
    const payload = event(
      'payment_method.detached',
      'pm_test_1',
      'payment_method',
    );
    await service.handle(payload);
    expect(methods.sync).toHaveBeenCalledOnce();
    expect(methods.markDetached).not.toHaveBeenCalled();
    gateway.retrievePaymentMethod.mockResolvedValueOnce({
      id: 'pm_test_1',
      type: 'card',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      bankName: null,
      customerId: null,
    });
    await service.handle(payload);
    expect(methods.markDetached).toHaveBeenCalledWith(
      'acct-local',
      'pm_test_1',
    );
  });

  it('keeps an unknown detached method retryable until its owner is known', async () => {
    const { service, methods } = harness();
    methods.findOwner.mockResolvedValueOnce(null);
    await expect(
      service.handle(
        event('payment_method.detached', 'pm_unknown', 'payment_method'),
      ),
    ).rejects.toThrow('no local owner');
  });
});
