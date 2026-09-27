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

export class PaymentConflictError extends Error {}

/** Record the intent and its invoice allocation before exposing its secret. */
export interface PaymentRecordStore {
  recordPending(input: {
    orgId: string;
    checkoutId: string;
    invoiceId: string;
    accountId: string;
    paymentIntentId: string;
    amountCents: number;
    applicationFeeCents: number;
    idempotencyKey: string;
  }): Promise<void>;
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
  /** Durable fence: after this commits, the key stays blocked until reconciled. */
  beginExternal(input: {
    orgId: string;
    checkoutId: string;
    key: string;
  }): Promise<void>;
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

function requestHash(input: CreateCheckoutPaymentInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        orgId: input.orgId,
        checkoutId: input.checkoutId,
        invoiceId: input.invoiceId,
        accountId: input.accountId,
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
    private readonly records: PaymentRecordStore,
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
    const reservation = await this.attempts.reserve({
      orgId: input.orgId,
      checkoutId: input.checkoutId,
      key: input.idempotencyKey,
      requestHash: requestHash(input),
    });
    if (reservation.kind === 'replay') return reservation.result;
    if (reservation.kind === 'busy')
      throw new PaymentConflictError('Payment attempt is already in progress');
    if (reservation.kind === 'conflict')
      throw new PaymentConflictError(
        'Idempotency-Key was used for a different payment',
      );
    let externalStarted = false;
    try {
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
      const account = await this.gateway.retrieveAccount(
        charge.connectedAccountId,
      );
      if (!account.chargesEnabled)
        throw new Error('Stripe account cannot accept charges');
      await this.attempts.beginExternal({
        orgId: input.orgId,
        checkoutId: input.checkoutId,
        key: input.idempotencyKey,
      });
      externalStarted = true;
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
      await this.records.recordPending({
        orgId: input.orgId,
        checkoutId: input.checkoutId,
        invoiceId: input.invoiceId,
        accountId: input.accountId,
        paymentIntentId: intent.id,
        amountCents: quote.amountCents,
        applicationFeeCents: quote.applicationFeeCents,
        idempotencyKey: input.idempotencyKey,
      });
      await this.attempts.complete({
        orgId: input.orgId,
        checkoutId: input.checkoutId,
        key: input.idempotencyKey,
        result,
      });
      return result;
    } catch (error) {
      if (!externalStarted) {
        await this.attempts.fail({
          orgId: input.orgId,
          checkoutId: input.checkoutId,
          key: input.idempotencyKey,
        });
      }
      throw error;
    }
  }
}
