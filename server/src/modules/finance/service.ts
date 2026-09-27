import { createHash } from 'node:crypto';

import {
  applicationFee,
  serviceFee,
  type FeeRate,
  type ServiceFeeConfig,
} from '@shared/algorithms/fees';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

export type ServiceFeeSetting =
  | { enabled: false }
  | { enabled: true; mode: 'cover_costs'; processing?: FeeRate }
  | { enabled: true; mode: 'custom'; custom: FeeRate };

/** Loaded inside withOrg from a frozen checkout or installment snapshot. */
export interface FrozenCharge {
  orgId: string;
  checkoutId: string;
  invoiceId: string;
  accountId: string;
  customerId: string;
  connectedAccountId: string;
  version: number;
  baseCents: number;
  taxCents: number;
  applicationRate: FeeRate;
  serviceFee: ServiceFeeSetting;
  autopayAuthorized: boolean;
  statementDescriptorSuffix?: string;
}

export interface FrozenChargeReader {
  load(input: {
    orgId: string;
    checkoutId: string;
    invoiceId: string;
    accountId: string;
  }): Promise<FrozenCharge | null>;
}

export interface PaymentQuote {
  baseCents: number;
  serviceFeeCents: number;
  taxCents: number;
  amountCents: number;
  applicationFeeCents: number;
}

export interface CreatedPaymentIntent {
  id: string;
  clientSecret: string;
  status: string;
  quote: PaymentQuote;
}

export type PaymentAttemptReservation =
  | { kind: 'reserved' }
  | { kind: 'replay'; result: CreatedPaymentIntent }
  | { kind: 'busy' }
  | { kind: 'conflict' };

/** Reserve must atomically compare request hashes and lease one creator per key. */
export interface PaymentAttemptStore {
  reserve(input: {
    orgId: string;
    checkoutId: string;
    key: string;
    requestHash: string;
  }): Promise<PaymentAttemptReservation>;
  complete(input: {
    orgId: string;
    checkoutId: string;
    key: string;
    result: CreatedPaymentIntent;
  }): Promise<void>;
  fail(input: {
    orgId: string;
    checkoutId: string;
    key: string;
  }): Promise<void>;
}

export interface CreateCheckoutPaymentInput {
  orgId: string;
  checkoutId: string;
  invoiceId: string;
  accountId: string;
  idempotencyKey: string;
  saveForAutopay: boolean;
}

export function quoteCharge(charge: FrozenCharge): PaymentQuote {
  const config: ServiceFeeConfig = !charge.serviceFee.enabled
    ? { enabled: false }
    : charge.serviceFee.mode === 'custom'
      ? { enabled: true, mode: 'custom', custom: charge.serviceFee.custom }
      : {
          enabled: true,
          mode: 'cover_costs',
          application: charge.applicationRate,
          ...(charge.serviceFee.processing
            ? { processing: charge.serviceFee.processing }
            : {}),
        };
  const serviceFeeCents = serviceFee(charge.baseCents, config);
  if (!Number.isSafeInteger(charge.taxCents) || charge.taxCents < 0) {
    throw new RangeError('Tax must be non-negative integer cents');
  }
  const gross =
    BigInt(charge.baseCents) +
    BigInt(serviceFeeCents) +
    BigInt(charge.taxCents);
  if (gross < 1n || gross > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Payment amount is outside the supported range');
  }
  const amountCents = Number(gross);
  return {
    baseCents: charge.baseCents,
    serviceFeeCents,
    taxCents: charge.taxCents,
    amountCents,
    applicationFeeCents: applicationFee(amountCents, charge.applicationRate),
  };
}

function requestHash(
  charge: FrozenCharge,
  input: CreateCheckoutPaymentInput,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        orgId: charge.orgId,
        checkoutId: charge.checkoutId,
        invoiceId: charge.invoiceId,
        accountId: charge.accountId,
        customerId: charge.customerId,
        connectedAccountId: charge.connectedAccountId,
        version: charge.version,
        baseCents: charge.baseCents,
        taxCents: charge.taxCents,
        applicationRate: charge.applicationRate,
        serviceFee: charge.serviceFee,
        statementDescriptorSuffix: charge.statementDescriptorSuffix ?? null,
        saveForAutopay: input.saveForAutopay,
      }),
    )
    .digest('hex');
}

export class CheckoutPaymentService {
  constructor(
    private readonly reader: FrozenChargeReader,
    private readonly attempts: PaymentAttemptStore,
    private readonly gateway: Pick<
      PaymentsGateway,
      'retrieveAccount' | 'createDestinationPayment'
    >,
  ) {}

  async create(
    input: CreateCheckoutPaymentInput,
  ): Promise<CreatedPaymentIntent> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.idempotencyKey,
      )
    ) {
      throw new Error('Idempotency-Key must be a UUID');
    }
    const charge = await this.reader.load(input);
    if (
      !charge ||
      charge.orgId !== input.orgId ||
      charge.checkoutId !== input.checkoutId ||
      charge.invoiceId !== input.invoiceId ||
      charge.accountId !== input.accountId
    ) {
      throw new Error('Frozen checkout charge not found');
    }
    if (input.saveForAutopay && !charge.autopayAuthorized) {
      throw new Error('Autopay authorization is required');
    }
    const quote = quoteCharge(charge);
    const hash = requestHash(charge, input);
    const reservation = await this.attempts.reserve({
      orgId: input.orgId,
      checkoutId: input.checkoutId,
      key: input.idempotencyKey,
      requestHash: hash,
    });
    if (reservation.kind === 'replay') return reservation.result;
    if (reservation.kind === 'busy')
      throw new Error('Payment attempt is already in progress');
    if (reservation.kind === 'conflict')
      throw new Error('Idempotency-Key was used for a different payment');
    try {
      const account = await this.gateway.retrieveAccount(
        charge.connectedAccountId,
      );
      if (!account.chargesEnabled)
        throw new Error('Stripe account cannot accept charges');
      const intent = await this.gateway.createDestinationPayment({
        amountCents: quote.amountCents,
        applicationFeeCents: quote.applicationFeeCents,
        customerId: charge.customerId,
        connectedAccountId: charge.connectedAccountId,
        orgId: input.orgId,
        invoiceId: input.invoiceId,
        checkoutId: input.checkoutId,
        idempotencyKey: `checkout:${input.checkoutId}:${input.idempotencyKey}`,
        saveForAutopay: input.saveForAutopay,
        ...(charge.statementDescriptorSuffix
          ? { statementDescriptorSuffix: charge.statementDescriptorSuffix }
          : {}),
      });
      if (!intent.clientSecret || intent.amountCents !== quote.amountCents) {
        throw new Error('Stripe PaymentIntent did not match the frozen charge');
      }
      const result: CreatedPaymentIntent = {
        id: intent.id,
        clientSecret: intent.clientSecret,
        status: intent.status,
        quote,
      };
      await this.attempts.complete({
        orgId: input.orgId,
        checkoutId: input.checkoutId,
        key: input.idempotencyKey,
        result,
      });
      return result;
    } catch (error) {
      await this.attempts.fail({
        orgId: input.orgId,
        checkoutId: input.checkoutId,
        key: input.idempotencyKey,
      });
      throw error;
    }
  }
}
