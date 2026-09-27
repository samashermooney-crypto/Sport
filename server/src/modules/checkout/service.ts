import { Temporal } from '@js-temporal/polyfill';
import {
  holdExpiresAt,
  shouldKeepProcessingHold,
} from '@shared/algorithms/capacity-math';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import type {
  CheckoutPaymentService,
  CreateCheckoutPaymentInput,
} from '../finance/service.js';

export type CapacitySubject = 'program' | 'division' | 'offering';
export interface SeatRequest {
  programId: string;
  divisionId: string;
  offeringId: string;
}
export interface SubjectQuantity {
  subject: CapacitySubject;
  id: string;
  quantity: number;
}

/**
 * Every method is one withOrg transaction. reserve locks counters in supplied
 * order and increments all or none; confirm updates counters and registrations
 * together. A checkout's repeated request key must not create another hold.
 */
export interface CheckoutCapacityRepository {
  reserve(input: {
    orgId: string;
    checkoutId: string;
    subjects: readonly SubjectQuantity[];
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<'reserved' | 'already_reserved' | 'full'>;
  extend(input: {
    orgId: string;
    checkoutId: string;
    expiresAt: string;
  }): Promise<boolean>;
  confirm(input: {
    orgId: string;
    checkoutId: string;
    honorProcessingHold: boolean;
  }): Promise<'confirmed' | 'already_confirmed' | 'expired'>;
  release(input: { orgId: string; checkoutId: string }): Promise<void>;
  keepForFailedPayment(input: {
    orgId: string;
    checkoutId: string;
    expiresAt: string;
  }): Promise<void>;
}

const order: Record<CapacitySubject, number> = {
  program: 0,
  division: 1,
  offering: 2,
};

export function subjectQuantities(
  seats: readonly SeatRequest[],
): SubjectQuantity[] {
  if (seats.length === 0)
    throw new RangeError('Checkout must reserve at least one seat');
  const quantities = new Map<string, SubjectQuantity>();
  for (const seat of seats) {
    for (const [subject, id] of [
      ['program', seat.programId],
      ['division', seat.divisionId],
      ['offering', seat.offeringId],
    ] as const) {
      if (!id) throw new RangeError('Capacity subject ID is required');
      const key = `${subject}:${id}`;
      const existing = quantities.get(key);
      if (existing) existing.quantity += 1;
      else quantities.set(key, { subject, id, quantity: 1 });
    }
  }
  return [...quantities.values()].sort(
    (a, b) => order[a.subject] - order[b.subject] || a.id.localeCompare(b.id),
  );
}

export class CheckoutService {
  constructor(
    private readonly capacity: CheckoutCapacityRepository,
    private readonly payments: Pick<CheckoutPaymentService, 'create'>,
    private readonly gateway: Pick<PaymentsGateway, 'createRefund'>,
  ) {}

  async reserveSeats(input: {
    orgId: string;
    checkoutId: string;
    seats: readonly SeatRequest[];
    createdAt: string;
    lastActivityAt: string;
    idempotencyKey: string;
  }): Promise<{ kind: 'reserved'; expiresAt: string } | { kind: 'full' }> {
    const expiresAt = holdExpiresAt(input.createdAt, input.lastActivityAt);
    const result = await this.capacity.reserve({
      orgId: input.orgId,
      checkoutId: input.checkoutId,
      subjects: subjectQuantities(input.seats),
      expiresAt,
      idempotencyKey: input.idempotencyKey,
    });
    return result === 'full'
      ? { kind: 'full' }
      : { kind: 'reserved', expiresAt };
  }

  async extendHold(input: {
    orgId: string;
    checkoutId: string;
    createdAt: string;
    lastActivityAt: string;
  }): Promise<string | null> {
    const expiresAt = holdExpiresAt(input.createdAt, input.lastActivityAt);
    return (await this.capacity.extend({
      orgId: input.orgId,
      checkoutId: input.checkoutId,
      expiresAt,
    }))
      ? expiresAt
      : null;
  }

  createPaymentIntent(input: CreateCheckoutPaymentInput) {
    return this.payments.create(input);
  }

  async confirmPaidCheckout(input: {
    orgId: string;
    checkoutId: string;
    checkoutStatus: string;
    processingStartedAt: string | null;
    holdExpiresAt: string;
    paymentIntentId: string;
    amountCents: number;
  }) {
    const honorProcessingHold = shouldKeepProcessingHold(
      input.checkoutStatus,
      input.processingStartedAt,
      input.holdExpiresAt,
    );
    const result = await this.capacity.confirm({
      orgId: input.orgId,
      checkoutId: input.checkoutId,
      honorProcessingHold,
    });
    if (result !== 'expired') return { kind: 'confirmed' as const };
    const refund = await this.gateway.createRefund({
      paymentIntentId: input.paymentIntentId,
      amountCents: input.amountCents,
      reverseTransfer: true,
      refundApplicationFee: true,
      idempotencyKey: `capacity-lost:${input.checkoutId}`,
    });
    return {
      kind: 'refund_initiated' as const,
      refundId: refund.id,
      refundStatus: refund.status,
    };
  }

  async failPayment(input: {
    orgId: string;
    checkoutId: string;
    failedAt: string;
  }): Promise<string> {
    const expiresAt = Temporal.Instant.from(input.failedAt)
      .add({ hours: 72 })
      .toString();
    await this.capacity.keepForFailedPayment({
      orgId: input.orgId,
      checkoutId: input.checkoutId,
      expiresAt,
    });
    return expiresAt;
  }

  releaseSeats(input: { orgId: string; checkoutId: string }): Promise<void> {
    return this.capacity.release(input);
  }
}
