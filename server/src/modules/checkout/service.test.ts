import { describe, expect, it, vi } from 'vitest';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import type { CheckoutPaymentService } from '../finance/service.js';

import {
  CheckoutService,
  subjectQuantities,
  type CheckoutCapacityRepository,
  type SeatRequest,
} from './service.js';

const seat: SeatRequest = {
  programId: 'program_1',
  divisionId: 'division_1',
  offeringId: 'offering_1',
};
const createdAt = '2026-09-26T20:00:00Z';

function service(repository: CheckoutCapacityRepository) {
  const create = vi.fn<CheckoutPaymentService['create']>();
  const createRefund = vi
    .fn<PaymentsGateway['createRefund']>()
    .mockResolvedValue({
      id: 're_test',
      status: 'pending',
      amountCents: 1000,
    });
  return {
    checkout: new CheckoutService(repository, { create }, { createRefund }),
    create,
    createRefund,
  };
}

describe('checkout capacity service', () => {
  it('orders and groups capacity changes before the repository transaction', () => {
    expect(subjectQuantities([seat, seat])).toEqual([
      { subject: 'program', id: 'program_1', quantity: 2 },
      { subject: 'division', id: 'division_1', quantity: 2 },
      { subject: 'offering', id: 'offering_1', quantity: 2 },
    ]);
  });

  it('holds only 100 of 300 concurrent checkouts when the atomic store has 100 seats', async () => {
    let held = 0;
    const repository: CheckoutCapacityRepository = {
      reserve: vi.fn().mockImplementation(() => {
        if (held >= 100) return Promise.resolve('full');
        held += 1;
        return Promise.resolve('reserved');
      }),
      extend: vi.fn().mockResolvedValue(true),
      confirm: vi.fn().mockResolvedValue('confirmed'),
      release: vi.fn().mockResolvedValue(undefined),
      keepForFailedPayment: vi.fn().mockResolvedValue(undefined),
    };
    const { checkout } = service(repository);
    const results = await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        checkout.reserveSeats({
          orgId: 'org_1',
          checkoutId: `checkout_${String(index)}`,
          seats: [seat],
          createdAt,
          lastActivityAt: createdAt,
          idempotencyKey: `hold_${String(index)}`,
        }),
      ),
    );
    expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(
      100,
    );
    expect(results.filter((result) => result.kind === 'full')).toHaveLength(
      200,
    );
    expect(held).toBe(100);
  });

  it('honors a payment already processing before the hold expired', async () => {
    const confirm = vi
      .fn<CheckoutCapacityRepository['confirm']>()
      .mockResolvedValue('confirmed');
    const repository: CheckoutCapacityRepository = {
      reserve: vi.fn().mockResolvedValue('reserved'),
      extend: vi.fn().mockResolvedValue(true),
      confirm,
      release: vi.fn().mockResolvedValue(undefined),
      keepForFailedPayment: vi.fn().mockResolvedValue(undefined),
    };
    const { checkout } = service(repository);
    const result = await checkout.confirmPaidCheckout({
      orgId: 'org_1',
      checkoutId: 'checkout_1',
      checkoutStatus: 'awaiting_payment',
      processingStartedAt: '2026-09-26T20:19:00Z',
      holdExpiresAt: '2026-09-26T20:20:00Z',
      paymentIntentId: 'pi_test',
      amountCents: 1000,
    });
    expect(result.kind).toBe('confirmed');
    expect(confirm.mock.calls[0]?.[0].honorProcessingHold).toBe(true);
  });

  it('initiates a full destination refund if paid capacity was lost', async () => {
    const repository: CheckoutCapacityRepository = {
      reserve: vi.fn().mockResolvedValue('reserved'),
      extend: vi.fn().mockResolvedValue(true),
      confirm: vi.fn().mockResolvedValue('expired'),
      release: vi.fn().mockResolvedValue(undefined),
      keepForFailedPayment: vi.fn().mockResolvedValue(undefined),
    };
    const { checkout, createRefund } = service(repository);
    const result = await checkout.confirmPaidCheckout({
      orgId: 'org_1',
      checkoutId: 'checkout_1',
      checkoutStatus: 'expired',
      processingStartedAt: null,
      holdExpiresAt: '2026-09-26T20:20:00Z',
      paymentIntentId: 'pi_test',
      amountCents: 1000,
    });
    expect(result.kind).toBe('refund_initiated');
    expect(createRefund).toHaveBeenCalledWith({
      paymentIntentId: 'pi_test',
      amountCents: 1000,
      reverseTransfer: true,
      refundApplicationFee: true,
      idempotencyKey: 'capacity-lost:checkout_1',
    });
  });

  it('extends failed-payment capacity for exactly 72 hours', async () => {
    const keepForFailedPayment = vi
      .fn<CheckoutCapacityRepository['keepForFailedPayment']>()
      .mockResolvedValue(undefined);
    const repository: CheckoutCapacityRepository = {
      reserve: vi.fn().mockResolvedValue('reserved'),
      extend: vi.fn().mockResolvedValue(true),
      confirm: vi.fn().mockResolvedValue('confirmed'),
      release: vi.fn().mockResolvedValue(undefined),
      keepForFailedPayment,
    };
    const { checkout } = service(repository);
    const expiresAt = await checkout.failPayment({
      orgId: 'org_1',
      checkoutId: 'checkout_1',
      failedAt: '2026-09-26T20:00:00Z',
    });
    expect(expiresAt).toBe('2026-09-29T20:00:00Z');
    expect(keepForFailedPayment.mock.calls[0]?.[0].expiresAt).toBe(expiresAt);
  });
});
