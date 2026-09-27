import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

import {
  PayerMethodsService,
  type PayerProfileRepository,
} from './payer-methods.js';

function harness() {
  let customerId: string | null = null;
  let reserved = false;
  const profiles = {
    reserve: vi.fn<PayerProfileRepository['reserve']>(() => {
      if (customerId) {
        return Promise.resolve({ kind: 'existing', customerId });
      }
      if (reserved) return Promise.resolve({ kind: 'busy' });
      reserved = true;
      return Promise.resolve({ kind: 'reserved' });
    }),
    save: vi.fn((_: string, id: string) => {
      customerId = id;
      return Promise.resolve();
    }),
    load: vi.fn(() => Promise.resolve(customerId)),
    findAccountByCustomer: vi.fn((id: string) =>
      Promise.resolve(id === customerId ? 'account-1' : null),
    ),
  } satisfies PayerProfileRepository;
  const gateway = {
    createCustomer: vi.fn<PaymentsGateway['createCustomer']>(() =>
      Promise.resolve({ id: 'cus_test_1' }),
    ),
    createSetupIntent: vi.fn<PaymentsGateway['createSetupIntent']>(() =>
      Promise.resolve({ id: 'seti_test_1', clientSecret: 'seti_test_secret' }),
    ),
    listPaymentMethods: vi.fn<PaymentsGateway['listPaymentMethods']>(() =>
      Promise.resolve([]),
    ),
    detachPaymentMethod: vi.fn<PaymentsGateway['detachPaymentMethod']>(() =>
      Promise.resolve(),
    ),
    setDefaultPaymentMethod: vi.fn<PaymentsGateway['setDefaultPaymentMethod']>(
      () => Promise.resolve(),
    ),
  };
  return {
    service: new PayerMethodsService(profiles, gateway),
    profiles,
    gateway,
  };
}

describe('payer method setup', () => {
  it('creates one platform Customer and uses separate SetupIntent keys', async () => {
    const { service, gateway } = harness();
    const input = {
      accountId: 'account-1',
      email: 'family@example.test',
      idempotencyKey: randomUUID(),
    };
    await expect(service.createSetupIntent(input)).resolves.toEqual({
      id: 'seti_test_1',
      clientSecret: 'seti_test_secret',
    });
    await service.createSetupIntent({ ...input, idempotencyKey: randomUUID() });
    expect(gateway.createCustomer).toHaveBeenCalledTimes(1);
    expect(gateway.createCustomer).toHaveBeenCalledWith({
      accountId: 'account-1',
      email: 'family@example.test',
      idempotencyKey: 'payer:account-1',
    });
    expect(gateway.createSetupIntent.mock.calls[0]?.[0]).toEqual({
      customerId: 'cus_test_1',
      idempotencyKey: `setup:account-1:${input.idempotencyKey}`,
    });
  });

  it('keeps an uncertain Customer creation fenced', async () => {
    const { service, gateway } = harness();
    const input = {
      accountId: 'account-1',
      email: 'family@example.test',
      idempotencyKey: randomUUID(),
    };
    gateway.createCustomer.mockRejectedValueOnce(new Error('network lost'));
    await expect(service.createSetupIntent(input)).rejects.toThrow(
      'network lost',
    );
    await expect(service.createSetupIntent(input)).rejects.toThrow(
      'already in progress',
    );
    expect(gateway.createCustomer).toHaveBeenCalledTimes(1);
    expect(gateway.createSetupIntent).not.toHaveBeenCalled();
  });

  it('lists only methods attached to the account Customer', async () => {
    const { service, gateway } = harness();
    await expect(service.list('account-1')).resolves.toEqual([]);
    expect(gateway.listPaymentMethods).not.toHaveBeenCalled();
    await service.createSetupIntent({
      accountId: 'account-1',
      email: 'family@example.test',
      idempotencyKey: randomUUID(),
    });
    await service.list('account-1');
    expect(gateway.listPaymentMethods).toHaveBeenCalledWith('cus_test_1');
  });

  it('rejects an invalid request key before creating a Customer', async () => {
    const { service, gateway } = harness();
    await expect(
      service.createSetupIntent({
        accountId: 'account-1',
        email: 'family@example.test',
        idempotencyKey: 'not-a-uuid',
      }),
    ).rejects.toThrow('UUID');
    expect(gateway.createCustomer).not.toHaveBeenCalled();
  });

  it('checks account ownership before detaching or changing the default', async () => {
    const { service, gateway } = harness();
    await service.createSetupIntent({
      accountId: 'account-1',
      email: 'family@example.test',
      idempotencyKey: randomUUID(),
    });
    await expect(service.remove('account-1', 'pm_other')).rejects.toThrow(
      'not attached',
    );
    expect(gateway.detachPaymentMethod).not.toHaveBeenCalled();
    gateway.listPaymentMethods.mockResolvedValue([
      {
        id: 'pm_owned',
        type: 'card',
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2030,
        bankName: null,
      },
    ]);
    await service.setDefault('account-1', 'pm_owned');
    await service.remove('account-1', 'pm_owned');
    expect(gateway.setDefaultPaymentMethod).toHaveBeenCalledWith(
      'cus_test_1',
      'pm_owned',
    );
    expect(gateway.detachPaymentMethod).toHaveBeenCalledWith('pm_owned');
  });
});
