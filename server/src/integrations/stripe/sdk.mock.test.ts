import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { StripeSdkGateway } from './sdk.js';

const enabled = process.env.STRIPE_MOCK_PORT !== undefined;

describe.skipIf(!enabled)('Stripe SDK against stripe-mock', () => {
  const stripe = new Stripe('sk_test_mock', {
    host: '127.0.0.1',
    port: Number(process.env.STRIPE_MOCK_PORT),
    protocol: 'http',
  });
  const gateway = new StripeSdkGateway('sk_test_mock', stripe);

  it('creates an Express account and destination PaymentIntent', async () => {
    const account = await gateway.createExpressAccount({
      orgId: 'org_mock',
      email: 'org@example.test',
      idempotencyKey: 'mock:account:1',
    });
    expect(account.id).toMatch(/^acct_/);
    const customer = await gateway.createCustomer({
      accountId: 'account_mock',
      email: 'payer@example.test',
      idempotencyKey: 'mock:customer:1',
    });
    expect(customer.id).toMatch(/^cus_/);
    const payment = await gateway.createDestinationPayment({
      amountCents: 1000,
      applicationFeeCents: 15,
      customerId: customer.id,
      connectedAccountId: account.id,
      orgId: 'org_mock',
      invoiceId: 'invoice_mock',
      idempotencyKey: 'mock:payment:1',
      saveForAutopay: false,
    });
    expect(payment.id).toMatch(/^pi_/);
    expect(payment.amountCents).toBe(1000);
  });
});
