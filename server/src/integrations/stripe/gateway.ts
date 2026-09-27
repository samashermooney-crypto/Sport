/** Stripe operations used by finance services. All amounts are integer USD cents. */
export interface PaymentsGateway {
  createExpressAccount(input: {
    orgId: string;
    email: string;
    idempotencyKey: string;
  }): Promise<{
    id: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  }>;
  createAccountLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  createExpressLoginLink(accountId: string): Promise<{ url: string }>;
  retrieveAccount(accountId: string): Promise<{
    id: string;
    orgId?: string | null;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    requirements: { currentlyDue: string[]; disabledReason: string | null };
  }>;
  createCustomer(input: {
    accountId: string;
    email: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  createSetupIntent(input: {
    customerId: string;
    idempotencyKey: string;
  }): Promise<{
    id: string;
    clientSecret: string;
  }>;
  retrieveSetupIntent(setupIntentId: string): Promise<{
    id: string;
    status: string;
    customerId: string | null;
    paymentMethodId: string | null;
  }>;
  retrievePaymentMethod(paymentMethodId: string): Promise<
    GatewayPaymentMethod & {
      customerId: string | null;
    }
  >;
  listPaymentMethods(customerId: string): Promise<GatewayPaymentMethod[]>;
  detachPaymentMethod(paymentMethodId: string): Promise<void>;
  setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<void>;
  createDestinationPayment(
    input: DestinationPaymentInput,
  ): Promise<GatewayPaymentIntent>;
  retrievePaymentIntent(paymentIntentId: string): Promise<GatewayPaymentIntent>;
  cancelPaymentIntent(
    paymentIntentId: string,
    idempotencyKey: string,
  ): Promise<GatewayPaymentIntent>;
  createRefund(input: {
    orgId?: string;
    paymentIntentId: string;
    amountCents: number;
    reverseTransfer: boolean;
    refundApplicationFee: boolean;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string; amountCents: number }>;
  retrieveRefund(refundId: string): Promise<GatewayRefund>;
  listRefundsForCharge(chargeId: string): Promise<GatewayRefund[]>;
  reverseTransfer(input: {
    transferId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ id: string; amountCents: number }>;
  retrieveDispute(disputeId: string): Promise<GatewayDispute>;
  retrieveTransfer(transferId: string): Promise<{
    id: string;
    amountCents: number;
    amountReversedCents: number;
    destinationAccountId: string;
  }>;
  createTransfer(input: {
    destinationAccountId: string;
    amountCents: number;
    disputeId: string;
    idempotencyKey: string;
  }): Promise<{ id: string; amountCents: number }>;
  submitDisputeEvidence(input: {
    disputeId: string;
    evidence: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string }>;
  listPayouts(
    accountId: string,
    startingAfter?: string,
  ): Promise<GatewayPage<GatewayPayout>>;
  retrievePayout(accountId: string, payoutId: string): Promise<GatewayPayout>;
  listBalanceTransactions(
    accountId: string,
    payoutId: string,
    startingAfter?: string,
  ): Promise<GatewayPage<GatewayBalanceTransaction>>;
  createBillingCheckout(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }>;
  createBillingPortal(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  registerPaymentMethodDomain(
    domainName: string,
  ): Promise<{ id: string; applePayStatus: string }>;
}

export interface DestinationPaymentInput {
  amountCents: number;
  applicationFeeCents: number;
  customerId: string;
  connectedAccountId: string;
  orgId: string;
  invoiceId: string;
  checkoutId?: string;
  installmentId?: string;
  idempotencyKey: string;
  saveForAutopay: boolean;
  statementDescriptorSuffix?: string;
  paymentMethodId?: string;
  offSession?: boolean;
}

export interface GatewayPaymentIntent {
  id: string;
  clientSecret: string | null;
  status: string;
  amountCents: number;
  latestChargeId: string | null;
  method?:
    'card' | 'us_bank_account' | 'link' | 'apple_pay' | 'google_pay' | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  orgId?: string | null;
}

export interface GatewayRefund {
  id: string;
  status: string;
  amountCents: number;
  paymentIntentId: string | null;
  orgId: string | null;
}

export interface GatewayDispute {
  id: string;
  chargeId: string;
  paymentIntentId: string | null;
  transferId: string | null;
  status: string;
  amountCents: number;
  feeCents: number;
  reason: string;
  evidenceDueBy: number | null;
  fundsWithdrawn: boolean;
  fundsReinstated: boolean;
  reinstatedNetCents: number;
}

export interface GatewayPaymentMethod {
  id: string;
  type: 'card' | 'us_bank_account' | 'link';
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  bankName: string | null;
}

export interface GatewayPage<T> {
  items: T[];
  hasMore: boolean;
}

export interface GatewayPayout {
  id: string;
  amountCents: number;
  status: string;
  arrivalDate: number;
}

export interface GatewayBalanceTransaction {
  id: string;
  amountCents: number;
  feeCents: number;
  netCents: number;
  sourceId: string | null;
  type: string;
}

export function assertTestStripeKey(secretKey: string): void {
  if (
    !secretKey.startsWith('sk_test_') ||
    secretKey.length <= 'sk_test_'.length
  ) {
    throw new Error('Only Stripe test secret keys are permitted');
  }
}

export function assertDestinationPayment(input: DestinationPaymentInput): void {
  for (const [field, cents] of [
    ['amountCents', input.amountCents],
    ['applicationFeeCents', input.applicationFeeCents],
  ] as const) {
    if (!Number.isSafeInteger(cents) || cents < 0) {
      throw new RangeError(`${field} must be non-negative integer cents`);
    }
  }
  if (input.amountCents < 1 || input.applicationFeeCents >= input.amountCents) {
    throw new RangeError('Application fee must be less than the charge');
  }
  if (input.offSession && !input.paymentMethodId) {
    throw new Error('Off-session payment requires a saved payment method');
  }
}
