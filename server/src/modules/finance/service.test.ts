import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

import {
  CheckoutPaymentService,
  quoteCharge,
  type CreatedPaymentIntent,
  type FrozenCharge,
  type FrozenChargeReader,
  type PaymentAttemptStore,
} from './service.js';

const charge: FrozenCharge = {
  orgId: 'org_1',
  checkoutId: 'checkout_1',
  invoiceId: 'invoice_1',
  accountId: 'account_1',
  customerId: 'cus_1',
  connectedAccountId: 'acct_1',
  version: 1,
  baseCents: 10_000,
  taxCents: 0,
  applicationRate: { bps: 150, fixedCents: 0 },
  serviceFee: { enabled: true, mode: 'cover_costs' },
  autopayAuthorized: true,
};

class AttemptStore implements PaymentAttemptStore {
  readonly records = new Map<
    string,
    { hash: string; result?: CreatedPaymentIntent }
  >();
  reserve({ key, requestHash }: { key: string; requestHash: string }) {
    const record = this.records.get(key);
    if (record?.hash !== undefined && record.hash !== requestHash) {
      return Promise.resolve({ kind: 'conflict' as const });
    }
    if (record?.result)
      return Promise.resolve({
        kind: 'replay' as const,
        result: record.result,
      });
    if (record) return Promise.resolve({ kind: 'busy' as const });
    this.records.set(key, { hash: requestHash });
    return Promise.resolve({ kind: 'reserved' as const });
  }
  complete({ key, result }: { key: string; result: CreatedPaymentIntent }) {
    const record = this.records.get(key);
    if (!record) throw new Error('Missing reservation');
    record.result = result;
    return Promise.resolve();
  }
  fail({ key }: { key: string }) {
    this.records.delete(key);
    return Promise.resolve();
  }
}

function fixture() {
  const current = { ...charge };
  const reader: FrozenChargeReader = {
    load: vi.fn().mockImplementation(() => Promise.resolve(current)),
  };
  const attempts = new AttemptStore();
  const retrieveAccount = vi
    .fn<PaymentsGateway['retrieveAccount']>()
    .mockResolvedValue({
      id: 'acct_1',
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirements: { currentlyDue: [], disabledReason: null },
    });
  const createDestinationPayment = vi
    .fn<PaymentsGateway['createDestinationPayment']>()
    .mockImplementation((input) =>
      Promise.resolve({
        id: 'pi_1',
        clientSecret: 'pi_secret',
        status: 'requires_payment_method',
        amountCents: input.amountCents,
        latestChargeId: null,
      }),
    );
  const service = new CheckoutPaymentService(reader, attempts, {
    retrieveAccount,
    createDestinationPayment,
  });
  const input = {
    orgId: charge.orgId,
    checkoutId: charge.checkoutId,
    invoiceId: charge.invoiceId,
    accountId: charge.accountId,
    idempotencyKey: randomUUID(),
    saveForAutopay: true,
  };
  return {
    current,
    reader,
    attempts,
    retrieveAccount,
    createDestinationPayment,
    service,
    input,
  };
}

describe('finance PaymentIntent orchestration', () => {
  it('uses Track B fees to gross up a method-independent service fee and exact application fee', () => {
    expect(quoteCharge(charge)).toEqual({
      baseCents: 10_000,
      serviceFeeCents: 492,
      taxCents: 0,
      amountCents: 10_492,
      applicationFeeCents: 157,
    });
    expect(
      quoteCharge({
        ...charge,
        serviceFee: {
          enabled: true,
          mode: 'custom',
          custom: { bps: 250, fixedCents: 50 },
        },
      }).serviceFeeCents,
    ).toBe(300);
  });

  it('creates one destination PaymentIntent and replays the same result for the same key', async () => {
    const test = fixture();
    const first = await test.service.create(test.input);
    const second = await test.service.create(test.input);
    expect(first).toEqual(second);
    expect(test.createDestinationPayment).toHaveBeenCalledTimes(1);
    expect(test.createDestinationPayment.mock.calls[0]?.[0]).toMatchObject({
      amountCents: 10_492,
      applicationFeeCents: 157,
      connectedAccountId: 'acct_1',
      customerId: 'cus_1',
      saveForAutopay: true,
      idempotencyKey: `checkout:checkout_1:${test.input.idempotencyKey}`,
    });
  });

  it('replays the original result after the frozen charge changes', async () => {
    const test = fixture();
    const original = await test.service.create(test.input);
    test.current.baseCents = 11_000;
    expect(await test.service.create(test.input)).toEqual(original);
    expect(test.createDestinationPayment).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused key for a different request body', async () => {
    const test = fixture();
    await test.service.create(test.input);
    await expect(
      test.service.create({ ...test.input, saveForAutopay: false }),
    ).rejects.toThrow('different payment');
    expect(test.createDestinationPayment).toHaveBeenCalledTimes(1);
  });

  it('blocks charges when Connect is disabled or autopay consent is absent', async () => {
    const test = fixture();
    test.retrieveAccount.mockResolvedValueOnce({
      id: 'acct_1',
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirements: { currentlyDue: [], disabledReason: null },
    });
    await expect(test.service.create(test.input)).rejects.toThrow(
      'cannot accept charges',
    );
    expect(test.createDestinationPayment).not.toHaveBeenCalled();
    test.current.autopayAuthorized = false;
    await expect(
      test.service.create({ ...test.input, idempotencyKey: randomUUID() }),
    ).rejects.toThrow('Autopay authorization');
  });

  it('rejects unsafe cents before reserving or contacting Stripe', async () => {
    const test = fixture();
    test.current.baseCents = 10_000.5;
    await expect(test.service.create(test.input)).rejects.toThrow('integer');
    expect(test.attempts.records.size).toBe(0);
    expect(test.createDestinationPayment).not.toHaveBeenCalled();
  });
});
