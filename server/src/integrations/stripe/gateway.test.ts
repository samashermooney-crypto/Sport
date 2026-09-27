import { describe, expect, it } from 'vitest';

import {
  assertDestinationPayment,
  assertTestStripeKey,
  type DestinationPaymentInput,
} from './gateway.js';

const payment: DestinationPaymentInput = {
  amountCents: 10_000,
  applicationFeeCents: 150,
  customerId: 'cus_test',
  connectedAccountId: 'acct_test',
  orgId: 'org_test',
  invoiceId: 'inv_test',
  idempotencyKey: 'charge:test',
  saveForAutopay: false,
};

describe('Stripe gateway boundaries', () => {
  it('permits only test secret keys', () => {
    expect(() => {
      assertTestStripeKey('sk_test_example');
    }).not.toThrow();
    expect(() => {
      assertTestStripeKey('sk_live_example');
    }).toThrow();
    expect(() => {
      assertTestStripeKey('rk_test_example');
    }).toThrow();
  });

  it('requires integer cents and a fee below the charge', () => {
    expect(() => {
      assertDestinationPayment(payment);
    }).not.toThrow();
    expect(() => {
      assertDestinationPayment({ ...payment, amountCents: 100.5 });
    }).toThrow();
    expect(() => {
      assertDestinationPayment({ ...payment, applicationFeeCents: 10_000 });
    }).toThrow();
    expect(() => {
      assertDestinationPayment({ ...payment, offSession: true });
    }).toThrow();
  });
});
