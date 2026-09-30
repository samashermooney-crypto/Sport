import { describe, expect, it, vi } from 'vitest';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

import {
  ConnectOnboardingService,
  type ConnectAccount,
  type ConnectAccountRepository,
} from './connect.js';

const orgId = 'org-1';
const accountId = 'acct_test_1';
const account: ConnectAccount = {
  orgId,
  stripeAccountId: accountId,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsDue: ['business_profile.url'],
  disabledReason: null,
};

function harness(initial: ConnectAccount | null = null) {
  let stored = initial;
  const repository = {
    reserve: vi.fn<ConnectAccountRepository['reserve']>(() =>
      Promise.resolve(
        stored
          ? { kind: 'existing' as const, account: stored }
          : { kind: 'reserved' as const },
      ),
    ),
    saveCreated: vi.fn((created: ConnectAccount) => {
      stored = created;
      return Promise.resolve();
    }),
    load: vi.fn(() => Promise.resolve(stored)),
    update: vi.fn((updated: ConnectAccount) => {
      stored = updated;
      return Promise.resolve();
    }),
  } satisfies ConnectAccountRepository;
  const gateway = {
    createExpressAccount: vi.fn(() =>
      Promise.resolve({
        id: accountId,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      }),
    ),
    createAccountLink: vi.fn(() =>
      Promise.resolve({ url: 'https://connect.stripe.com/onboard' }),
    ),
    createExpressLoginLink: vi.fn(() =>
      Promise.resolve({ url: 'https://dashboard.stripe.com/express' }),
    ),
    retrieveAccount: vi.fn(() =>
      Promise.resolve({
        id: accountId,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirements: {
          currentlyDue: ['business_profile.url'],
          disabledReason: null,
        },
      }),
    ),
  } satisfies Pick<
    PaymentsGateway,
    | 'createExpressAccount'
    | 'createAccountLink'
    | 'createExpressLoginLink'
    | 'retrieveAccount'
  >;
  const service = new ConnectOnboardingService(repository, gateway, {
    returnUrl: (org) => `https://app.example.test/${org}/stripe/return`,
    refreshUrl: (org) => `https://app.example.test/${org}/stripe/refresh`,
  });
  return { service, repository, gateway, getStored: () => stored };
}

describe('Connect onboarding service', () => {
  it('does not resolve the gateway when a reservation is already busy', async () => {
    const { repository } = harness();
    repository.reserve.mockResolvedValueOnce({ kind: 'busy' });
    const gatewayFactory = vi.fn(() => {
      throw new Error('Stripe test gateway is unavailable');
    });
    const service = new ConnectOnboardingService(repository, gatewayFactory, {
      returnUrl: (org) => `https://app.example.test/${org}/stripe/return`,
      refreshUrl: (org) => `https://app.example.test/${org}/stripe/refresh`,
    });

    await expect(service.create(orgId, 'finance@example.test')).rejects.toThrow(
      'already in progress',
    );
    expect(gatewayFactory).not.toHaveBeenCalled();
  });

  it('creates one Express account using an org-stable key and persists latest status', async () => {
    const { service, repository, gateway, getStored } = harness();
    await expect(
      service.create(orgId, 'finance@example.test'),
    ).resolves.toEqual({
      url: 'https://connect.stripe.com/onboard',
    });
    expect(gateway.createExpressAccount).toHaveBeenCalledWith({
      orgId,
      email: 'finance@example.test',
      idempotencyKey: 'connect:org-1',
    });
    expect(getStored()).toEqual(account);
    expect(gateway.createAccountLink).toHaveBeenCalledWith({
      accountId,
      returnUrl: 'https://app.example.test/org-1/stripe/return',
      refreshUrl: 'https://app.example.test/org-1/stripe/refresh',
    });
    await service.create(orgId, 'other@example.test');
    expect(gateway.createExpressAccount).toHaveBeenCalledTimes(1);
    expect(repository.saveCreated).toHaveBeenCalledTimes(1);
  });

  it('does not create another account while creation is leased', async () => {
    const { service, repository, gateway } = harness();
    repository.reserve.mockResolvedValueOnce({ kind: 'busy' });
    await expect(service.create(orgId, 'finance@example.test')).rejects.toThrow(
      'already in progress',
    );
    expect(gateway.createExpressAccount).not.toHaveBeenCalled();
  });

  it('leaves an uncertain creation blocked and rejects a foreign account update', async () => {
    const { service, repository, gateway } = harness();
    gateway.createExpressAccount.mockRejectedValueOnce(
      new Error('Stripe unavailable'),
    );
    await expect(service.create(orgId, 'finance@example.test')).rejects.toThrow(
      'Stripe unavailable',
    );
    expect(repository.saveCreated).not.toHaveBeenCalled();
    const existing = harness(account);
    await expect(
      existing.service.refresh(orgId, 'acct_foreign'),
    ).rejects.toThrow('does not belong');
  });

  it('refreshes before issuing dashboard login and requires payments and payouts', async () => {
    const { service, gateway, repository } = harness(account);
    await expect(service.dashboard(orgId)).rejects.toThrow('not yet enabled');
    expect(gateway.createExpressLoginLink).not.toHaveBeenCalled();
    gateway.retrieveAccount.mockResolvedValueOnce({
      id: accountId,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirements: { currentlyDue: [], disabledReason: null },
    });
    await expect(service.dashboard(orgId)).resolves.toEqual({
      url: 'https://dashboard.stripe.com/express',
    });
    expect(repository.update).toHaveBeenCalledWith(
      expect.objectContaining({ chargesEnabled: true, payoutsEnabled: true }),
    );
  });

  it('rejects an insecure return URL before requesting an account link', async () => {
    const { repository, gateway } = harness(account);
    const service = new ConnectOnboardingService(repository, gateway, {
      returnUrl: () => 'http://app.example.test/return',
      refreshUrl: () => 'https://app.example.test/refresh',
    });
    await expect(service.continue(orgId)).rejects.toThrow('HTTPS');
    expect(gateway.createAccountLink).not.toHaveBeenCalled();
  });
});
