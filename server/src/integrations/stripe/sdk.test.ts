import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import { StripeSdkGateway } from './sdk.js';

function gateway() {
  const stripe = new Stripe('sk_test_fixture');
  return { stripe, gateway: new StripeSdkGateway('sk_test_fixture', stripe) };
}

describe('Stripe SDK gateway', () => {
  it('binds Billing Checkout and subscriptions to the organization in test mode', async () => {
    const test = gateway();
    const createCustomer = vi
      .spyOn(test.stripe.customers, 'create')
      .mockResolvedValue({
        id: 'cus_billing',
      } as Stripe.Response<Stripe.Customer>);
    await test.gateway.createBillingCustomer({
      orgId: 'org_billing',
      name: 'Billing Club',
      email: 'billing@example.test',
      idempotencyKey: 'billing:customer:org_billing',
    });
    expect(createCustomer.mock.calls[0]?.[0]).toMatchObject({
      metadata: { org_id: 'org_billing' },
    });
    const createCheckout = vi
      .spyOn(test.stripe.checkout.sessions, 'create')
      .mockResolvedValue({
        id: 'cs_test_billing',
        url: 'https://checkout.stripe.com/test',
      } as Stripe.Response<Stripe.Checkout.Session>);
    await test.gateway.createBillingCheckout({
      orgId: 'org_billing',
      customerId: 'cus_billing',
      priceId: 'price_billing',
      successUrl: 'https://app.example.test/billing/return',
      cancelUrl: 'https://app.example.test/billing',
      idempotencyKey: 'billing:checkout:org_billing',
    });
    expect(createCheckout.mock.calls[0]?.[0]).toMatchObject({
      client_reference_id: 'org_billing',
      subscription_data: { metadata: { org_id: 'org_billing' } },
    });
    const retrieve = vi
      .spyOn(test.stripe.subscriptions, 'retrieve')
      .mockResolvedValue({
        id: 'sub_billing',
        customer: 'cus_billing',
        metadata: { org_id: 'org_billing' },
        items: {
          data: [
            {
              price: { id: 'price_billing' },
              current_period_end: 1_900_000_000,
            },
          ],
        },
        status: 'active',
      } as unknown as Stripe.Response<Stripe.Subscription>);
    expect(
      await test.gateway.retrieveBillingSubscription('sub_billing'),
    ).toMatchObject({
      id: 'sub_billing',
      orgId: 'org_billing',
      customerId: 'cus_billing',
      priceIds: ['price_billing'],
      currentPeriodEnd: 1_900_000_000,
    });
    expect(retrieve).toHaveBeenCalledWith('sub_billing');
  });
  it('creates controller-based Express accounts', async () => {
    const test = gateway();
    const create = vi.spyOn(test.stripe.accounts, 'create').mockResolvedValue({
      id: 'acct_test',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
    } as Stripe.Response<Stripe.Account>);
    await test.gateway.createExpressAccount({
      orgId: 'org_1',
      email: 'org@example.test',
      idempotencyKey: 'org:1',
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      controller: { stripe_dashboard: { type: 'express' } },
      metadata: { org_id: 'org_1' },
    });
    expect(create.mock.calls[0]?.[1]).toEqual({ idempotencyKey: 'org:1' });
  });

  it('creates a platform destination charge with exact fee and retry key', async () => {
    const test = gateway();
    const create = vi
      .spyOn(test.stripe.paymentIntents, 'create')
      .mockResolvedValue({
        id: 'pi_test',
        client_secret: 'pi_test_secret',
        status: 'requires_payment_method',
        amount: 10_000,
        latest_charge: null,
        metadata: { org_id: 'org_1' },
      } as unknown as Stripe.Response<Stripe.PaymentIntent>);
    const result = await test.gateway.createDestinationPayment({
      amountCents: 10_000,
      applicationFeeCents: 150,
      customerId: 'cus_1',
      connectedAccountId: 'acct_1',
      orgId: 'org_1',
      invoiceId: 'inv_1',
      checkoutId: 'co_1',
      idempotencyKey: 'checkout:co_1:1',
      saveForAutopay: true,
    });
    expect(result.amountCents).toBe(10_000);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      amount: 10_000,
      currency: 'usd',
      customer: 'cus_1',
      on_behalf_of: 'acct_1',
      transfer_data: { destination: 'acct_1' },
      application_fee_amount: 150,
      setup_future_usage: 'off_session',
      metadata: { org_id: 'org_1', invoice_id: 'inv_1', checkout_id: 'co_1' },
    });
    expect(create.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: 'checkout:co_1:1',
    });
  });

  it('reverses transfers and application fees on destination charge refunds', async () => {
    const test = gateway();
    const create = vi.spyOn(test.stripe.refunds, 'create').mockResolvedValue({
      id: 're_test',
      status: 'succeeded',
      amount: 500,
    } as Stripe.Response<Stripe.Refund>);
    const result = await test.gateway.createRefund({
      paymentIntentId: 'pi_test',
      amountCents: 500,
      reverseTransfer: true,
      refundApplicationFee: true,
      idempotencyKey: 'refund:1',
    });
    expect(result.amountCents).toBe(500);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      payment_intent: 'pi_test',
      amount: 500,
      reverse_transfer: true,
      refund_application_fee: true,
    });
  });

  it('uses Stripe SDK signature verification on raw webhook bytes', () => {
    const test = gateway();
    const payload = JSON.stringify({
      id: 'evt_test',
      object: 'event',
      type: 'payment_intent.succeeded',
      created: 1_700_000_000,
      livemode: false,
      data: { object: { id: 'pi_test', object: 'payment_intent' } },
    });
    const signature = test.stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_fixture',
    });
    expect(
      test.gateway.verifyWebhook(
        Buffer.from(payload),
        signature,
        'whsec_fixture',
      ).id,
    ).toBe('evt_test');
    expect(() => {
      test.gateway.verifyWebhook(
        Buffer.from(`${payload} `),
        signature,
        'whsec_fixture',
      );
    }).toThrow();
  });
});
