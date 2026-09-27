import Stripe from 'stripe';

import {
  assertDestinationPayment,
  assertTestStripeKey,
  type DestinationPaymentInput,
  type GatewayBalanceTransaction,
  type GatewayPaymentMethod,
  type GatewayPaymentIntent,
  type GatewayRefund,
  type GatewayPayout,
  type PaymentsGateway,
} from './gateway.js';
import { parseStripeWebhookEvent } from './webhooks.js';

function paymentIntentView(intent: Stripe.PaymentIntent): GatewayPaymentIntent {
  const charge =
    typeof intent.latest_charge === 'string' ? null : intent.latest_charge;
  const details = charge?.payment_method_details;
  const wallet = details?.type === 'card' ? details.card?.wallet?.type : null;
  const paymentMethod =
    typeof intent.payment_method === 'string' ? null : intent.payment_method;
  const type = details?.type ?? paymentMethod?.type ?? null;
  const method =
    wallet === 'apple_pay'
      ? ('apple_pay' as const)
      : wallet === 'google_pay'
        ? ('google_pay' as const)
        : type === 'card' || type === 'us_bank_account' || type === 'link'
          ? type
          : null;
  return {
    id: intent.id,
    clientSecret: intent.client_secret,
    status: intent.status,
    amountCents: intent.amount,
    latestChargeId:
      typeof intent.latest_charge === 'string'
        ? intent.latest_charge
        : (intent.latest_charge?.id ?? null),
    method,
    failureCode:
      intent.last_payment_error?.decline_code ??
      intent.last_payment_error?.code ??
      null,
    failureMessage: intent.last_payment_error?.message ?? null,
    orgId: intent.metadata.org_id ?? null,
  };
}

export class StripeSdkGateway implements PaymentsGateway {
  constructor(
    secretKey: string,
    private readonly stripe: Stripe,
  ) {
    assertTestStripeKey(secretKey);
  }

  verifyWebhook(
    rawBody: Buffer,
    signatureHeader: string,
    endpointSecret: string,
  ) {
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      endpointSecret,
    );
    return parseStripeWebhookEvent(event);
  }

  async createExpressAccount(input: {
    orgId: string;
    email: string;
    idempotencyKey: string;
  }) {
    const account = await this.stripe.accounts.create(
      {
        country: 'US',
        email: input.email,
        controller: {
          stripe_dashboard: { type: 'express' },
          fees: { payer: 'application' },
          losses: { payments: 'application' },
          requirement_collection: 'stripe',
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { org_id: input.orgId },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return {
      id: account.id,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    };
  }

  async createAccountLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }) {
    const link = await this.stripe.accountLinks.create({
      account: input.accountId,
      refresh_url: input.refreshUrl,
      return_url: input.returnUrl,
      type: 'account_onboarding',
    });
    return { url: link.url };
  }

  async createExpressLoginLink(accountId: string) {
    return this.stripe.accounts.createLoginLink(accountId);
  }

  async retrieveAccount(accountId: string) {
    const account = await this.stripe.accounts.retrieve(accountId);
    return {
      id: account.id,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: {
        currentlyDue: account.requirements?.currently_due ?? [],
        disabledReason: account.requirements?.disabled_reason ?? null,
      },
    };
  }

  async createCustomer(input: {
    accountId: string;
    email: string;
    idempotencyKey: string;
  }) {
    const customer = await this.stripe.customers.create(
      {
        email: input.email,
        metadata: { account_id: input.accountId },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: customer.id };
  }

  async createSetupIntent(input: {
    customerId: string;
    idempotencyKey: string;
  }) {
    const intent = await this.stripe.setupIntents.create(
      {
        customer: input.customerId,
        payment_method_types: ['card', 'us_bank_account'],
        usage: 'off_session',
        payment_method_options: {
          us_bank_account: {
            financial_connections: { permissions: ['payment_method'] },
          },
        },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (!intent.client_secret)
      throw new Error('Stripe SetupIntent has no client secret');
    return { id: intent.id, clientSecret: intent.client_secret };
  }

  async retrieveSetupIntent(setupIntentId: string) {
    const intent = await this.stripe.setupIntents.retrieve(setupIntentId);
    return {
      id: intent.id,
      status: intent.status,
      customerId:
        typeof intent.customer === 'string'
          ? intent.customer
          : (intent.customer?.id ?? null),
      paymentMethodId:
        typeof intent.payment_method === 'string'
          ? intent.payment_method
          : (intent.payment_method?.id ?? null),
    };
  }

  async retrievePaymentMethod(paymentMethodId: string) {
    const method = await this.stripe.paymentMethods.retrieve(paymentMethodId);
    const type =
      method.type === 'card'
        ? ('card' as const)
        : method.type === 'us_bank_account'
          ? ('us_bank_account' as const)
          : method.type === 'link'
            ? ('link' as const)
            : null;
    if (!type) throw new Error('Unsupported Stripe payment method type');
    return {
      id: method.id,
      type,
      brand: method.card?.brand ?? null,
      last4: method.card?.last4 ?? method.us_bank_account?.last4 ?? null,
      expMonth: method.card?.exp_month ?? null,
      expYear: method.card?.exp_year ?? null,
      bankName: method.us_bank_account?.bank_name ?? null,
      customerId:
        typeof method.customer === 'string'
          ? method.customer
          : (method.customer?.id ?? null),
    };
  }

  async listPaymentMethods(
    customerId: string,
  ): Promise<GatewayPaymentMethod[]> {
    const methods: GatewayPaymentMethod[] = [];
    for (const type of ['card', 'us_bank_account', 'link'] as const) {
      const page = await this.stripe.paymentMethods.list({
        customer: customerId,
        type,
        limit: 100,
      });
      if (page.has_more)
        throw new Error('Stripe payment methods require pagination');
      for (const method of page.data) {
        methods.push({
          id: method.id,
          type,
          brand: method.card?.brand ?? null,
          last4: method.card?.last4 ?? method.us_bank_account?.last4 ?? null,
          expMonth: method.card?.exp_month ?? null,
          expYear: method.card?.exp_year ?? null,
          bankName: method.us_bank_account?.bank_name ?? null,
        });
      }
    }
    return methods;
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<void> {
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  async createDestinationPayment(
    input: DestinationPaymentInput,
  ): Promise<GatewayPaymentIntent> {
    assertDestinationPayment(input);
    const payment = await this.stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: 'usd',
        customer: input.customerId,
        on_behalf_of: input.connectedAccountId,
        transfer_data: { destination: input.connectedAccountId },
        application_fee_amount: input.applicationFeeCents,
        automatic_payment_methods: { enabled: true },
        ...(input.saveForAutopay ? { setup_future_usage: 'off_session' } : {}),
        ...(input.statementDescriptorSuffix
          ? { statement_descriptor_suffix: input.statementDescriptorSuffix }
          : {}),
        ...(input.paymentMethodId
          ? { payment_method: input.paymentMethodId }
          : {}),
        ...(input.offSession ? { confirm: true, off_session: true } : {}),
        metadata: {
          org_id: input.orgId,
          invoice_id: input.invoiceId,
          ...(input.checkoutId ? { checkout_id: input.checkoutId } : {}),
          ...(input.installmentId
            ? { installment_id: input.installmentId }
            : {}),
        },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return paymentIntentView(payment);
  }

  async retrievePaymentIntent(paymentIntentId: string) {
    return paymentIntentView(
      await this.stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['payment_method', 'latest_charge'],
      }),
    );
  }

  async cancelPaymentIntent(paymentIntentId: string, idempotencyKey: string) {
    return paymentIntentView(
      await this.stripe.paymentIntents.cancel(
        paymentIntentId,
        {},
        { idempotencyKey },
      ),
    );
  }

  async createRefund(input: {
    orgId?: string;
    paymentIntentId: string;
    amountCents: number;
    reverseTransfer: boolean;
    refundApplicationFee: boolean;
    idempotencyKey: string;
  }) {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1) {
      throw new RangeError('Refund amount must be positive integer cents');
    }
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountCents,
        reverse_transfer: input.reverseTransfer,
        refund_application_fee: input.refundApplicationFee,
        ...(input.orgId ? { metadata: { org_id: input.orgId } } : {}),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return {
      id: refund.id,
      status: refund.status ?? 'pending',
      amountCents: refund.amount,
    };
  }

  async retrieveRefund(refundId: string): Promise<GatewayRefund> {
    const refund = await this.stripe.refunds.retrieve(refundId);
    return this.refundView(refund);
  }

  async listRefundsForCharge(chargeId: string): Promise<GatewayRefund[]> {
    const page = await this.stripe.refunds.list({
      charge: chargeId,
      limit: 100,
    });
    if (page.has_more)
      throw new Error('Stripe charge refunds require pagination');
    return page.data.map((refund) => this.refundView(refund));
  }

  private refundView(refund: Stripe.Refund): GatewayRefund {
    return {
      id: refund.id,
      status: refund.status ?? 'pending',
      amountCents: refund.amount,
      paymentIntentId:
        typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : (refund.payment_intent?.id ?? null),
      orgId: refund.metadata?.org_id ?? null,
    };
  }

  async reverseTransfer(input: {
    transferId: string;
    amountCents: number;
    idempotencyKey: string;
  }) {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1) {
      throw new RangeError('Reversal amount must be positive integer cents');
    }
    const reversal = await this.stripe.transfers.createReversal(
      input.transferId,
      { amount: input.amountCents },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: reversal.id, amountCents: reversal.amount };
  }

  async submitDisputeEvidence(input: {
    disputeId: string;
    evidence: Record<string, string>;
    idempotencyKey: string;
  }) {
    const dispute = await this.stripe.disputes.update(
      input.disputeId,
      {
        evidence: input.evidence,
        submit: true,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: dispute.id, status: dispute.status };
  }

  async listPayouts(accountId: string, startingAfter?: string) {
    const page = await this.stripe.payouts.list(
      {
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      { stripeAccount: accountId },
    );
    const items: GatewayPayout[] = page.data.map((payout) => ({
      id: payout.id,
      amountCents: payout.amount,
      status: payout.status,
      arrivalDate: payout.arrival_date,
    }));
    return { items, hasMore: page.has_more };
  }

  async listBalanceTransactions(accountId: string, payoutId: string) {
    const page = await this.stripe.balanceTransactions.list(
      {
        payout: payoutId,
        limit: 100,
      },
      { stripeAccount: accountId },
    );
    const items: GatewayBalanceTransaction[] = page.data.map((transaction) => ({
      id: transaction.id,
      amountCents: transaction.amount,
      feeCents: transaction.fee,
      netCents: transaction.net,
      sourceId:
        typeof transaction.source === 'string'
          ? transaction.source
          : (transaction.source?.id ?? null),
      type: transaction.type,
    }));
    return { items, hasMore: page.has_more };
  }

  async createBillingCheckout(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: input.customerId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (!session.url) throw new Error('Stripe Billing Checkout has no URL');
    return { id: session.id, url: session.url };
  }

  async createBillingPortal(input: { customerId: string; returnUrl: string }) {
    return this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
  }

  async registerPaymentMethodDomain(domainName: string) {
    const domain = await this.stripe.paymentMethodDomains.create({
      domain_name: domainName,
    });
    return { id: domain.id, applePayStatus: domain.apple_pay.status };
  }
}

export function createStripeGateway(secretKey: string): StripeSdkGateway {
  assertTestStripeKey(secretKey);
  return new StripeSdkGateway(secretKey, new Stripe(secretKey));
}
