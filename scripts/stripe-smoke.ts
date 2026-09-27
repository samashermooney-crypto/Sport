import { randomUUID } from 'node:crypto';

import Stripe from 'stripe';

import { assertTestStripeKey } from '../server/src/integrations/stripe/gateway.js';
import { createStripeGateway } from '../server/src/integrations/stripe/sdk.js';

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required');
assertTestStripeKey(secretKey);

const stripe = new Stripe(secretKey);
const gateway = createStripeGateway(secretKey);
const accountId = process.env.STRIPE_TEST_CONNECTED_ACCOUNT_ID;

if (!accountId) {
  const account = await gateway.createExpressAccount({
    orgId: 'stripe-smoke',
    email: process.env.STRIPE_TEST_ORG_EMAIL ?? 'finance@example.test',
    idempotencyKey: `smoke:account:${new Date().toISOString().slice(0, 10)}`,
  });
  const appUrl = process.env.STRIPE_SMOKE_RETURN_URL ?? 'http://localhost:5173';
  const link = await gateway.createAccountLink({
    accountId: account.id,
    refreshUrl: `${appUrl}/stripe-smoke/refresh`,
    returnUrl: `${appUrl}/stripe-smoke/return`,
  });
  console.log(`Test Express account: ${account.id}`);
  console.log(`Complete test onboarding: ${link.url}`);
  console.log(
    'Set STRIPE_TEST_CONNECTED_ACCOUNT_ID to that account ID and rerun after charges are enabled.',
  );
  process.exit(0);
}

const account = await gateway.retrieveAccount(accountId);
if (!account.chargesEnabled) {
  throw new Error(
    `Test Express account ${accountId} is not enabled for charges`,
  );
}

const runId = randomUUID();
const customer = await gateway.createCustomer({
  accountId: `smoke-${runId}`,
  email: process.env.STRIPE_TEST_PAYER_EMAIL ?? 'payer@example.test',
  idempotencyKey: `smoke:customer:${runId}`,
});

const method = await stripe.paymentMethods.create({
  type: 'card',
  card: { token: 'tok_visa' },
});
await stripe.paymentMethods.attach(method.id, { customer: customer.id });
const payment = await gateway.createDestinationPayment({
  amountCents: 1000,
  applicationFeeCents: 15,
  customerId: customer.id,
  connectedAccountId: accountId,
  orgId: 'stripe-smoke',
  invoiceId: `smoke-${runId}`,
  idempotencyKey: `smoke:payment:${runId}`,
  saveForAutopay: false,
  paymentMethodId: method.id,
  offSession: true,
});

const latest = await gateway.retrievePaymentIntent(payment.id);
if (latest.status !== 'succeeded') {
  throw new Error(`Test payment did not succeed: ${latest.status}`);
}

const refund = await gateway.createRefund({
  paymentIntentId: payment.id,
  amountCents: 200,
  reverseTransfer: true,
  refundApplicationFee: true,
  idempotencyKey: `smoke:refund:${runId}`,
});

console.log(
  JSON.stringify(
    {
      mode: 'test',
      accountId,
      customerId: customer.id,
      paymentIntentId: payment.id,
      chargeId: latest.latestChargeId,
      grossCents: 1000,
      applicationFeeCents: 15,
      refundId: refund.id,
      refundCents: refund.amountCents,
      remainingGrossCents: 1000 - refund.amountCents,
    },
    null,
    2,
  ),
);
