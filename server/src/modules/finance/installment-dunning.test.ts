import { describe, expect, it, vi } from 'vitest';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

import {
  InstallmentDunningService,
  type InstallmentChargeClaim,
  type InstallmentChargeRepository,
} from './installment-dunning.js';

const claim: InstallmentChargeClaim = {
  id: 'claim-1',
  leaseToken: 'lease-1',
  orgId: 'org-1',
  installmentId: 'inst-1',
  invoiceId: 'invoice-1',
  accountId: 'account-1',
  customerId: 'cus_test_1',
  connectedAccountId: 'acct_test_1',
  paymentMethodId: 'pm_test_1',
  method: 'card',
  attemptNumber: 2,
  amountCents: 1000,
  applicationFeeCents: 15,
};

function harness() {
  const repository = {
    claimDue: vi.fn<InstallmentChargeRepository['claimDue']>(() =>
      Promise.resolve(claim),
    ),
    beginExternal: vi.fn<InstallmentChargeRepository['beginExternal']>(() =>
      Promise.resolve(),
    ),
    recordIntent: vi.fn<InstallmentChargeRepository['recordIntent']>(() =>
      Promise.resolve(),
    ),
  };
  const gateway = {
    retrieveAccount: vi.fn<PaymentsGateway['retrieveAccount']>(() =>
      Promise.resolve({
        id: 'acct_test_1',
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        requirements: { currentlyDue: [], disabledReason: null },
      }),
    ),
    createDestinationPayment: vi.fn<
      PaymentsGateway['createDestinationPayment']
    >(() =>
      Promise.resolve({
        id: 'pi_test_1',
        clientSecret: null,
        status: 'processing',
        amountCents: 1000,
        latestChargeId: null,
      }),
    ),
  };
  return {
    service: new InstallmentDunningService(repository, gateway),
    repository,
    gateway,
  };
}

describe('off-session installment dunning', () => {
  it('fences Stripe before creating a charge with a stable attempt key', async () => {
    const { service, repository, gateway } = harness();
    await expect(
      service.chargeOne('org-1', '2026-09-26T15:00:00Z'),
    ).resolves.toEqual({ kind: 'created', paymentIntentId: 'pi_test_1' });
    expect(repository.beginExternal).toHaveBeenCalledWith(claim);
    expect(gateway.createDestinationPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        installmentId: 'inst-1',
        paymentMethodId: 'pm_test_1',
        offSession: true,
        amountCents: 1000,
        applicationFeeCents: 15,
        idempotencyKey: 'inst:inst-1:2',
      }),
    );
    expect(repository.recordIntent).toHaveBeenCalledWith(claim, 'pi_test_1');
    expect(repository.beginExternal.mock.invocationCallOrder[0]).toBeLessThan(
      gateway.createDestinationPayment.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('does not call Stripe without a claim or enabled Connect account', async () => {
    const { service, repository, gateway } = harness();
    repository.claimDue.mockResolvedValueOnce(null);
    await expect(
      service.chargeOne('org-1', '2026-09-26T15:00:00Z'),
    ).resolves.toEqual({ kind: 'none' });
    gateway.retrieveAccount.mockResolvedValueOnce({
      id: 'acct_test_1',
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirements: {
        currentlyDue: ['external_account'],
        disabledReason: 'requirements.pending_verification',
      },
    });
    await expect(
      service.chargeOne('org-1', '2026-09-26T15:00:00Z'),
    ).rejects.toThrow('cannot accept charges');
    expect(gateway.createDestinationPayment).not.toHaveBeenCalled();
  });

  it('leaves ambiguous Stripe results fenced for reconciliation', async () => {
    const { service, repository, gateway } = harness();
    gateway.createDestinationPayment.mockRejectedValueOnce(
      new Error('network lost'),
    );
    await expect(
      service.chargeOne('org-1', '2026-09-26T15:00:00Z'),
    ).rejects.toThrow('network lost');
    expect(repository.beginExternal).toHaveBeenCalledOnce();
    expect(repository.recordIntent).not.toHaveBeenCalled();
  });
});
