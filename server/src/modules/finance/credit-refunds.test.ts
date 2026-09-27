import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  CreditRefundService,
  type CreditRefundRepository,
  type CreditRefundResult,
} from './credit-refunds.js';
import type { RefundSource } from './refunds.js';

const source: RefundSource = {
  orgId: 'org-1',
  paymentId: 'payment-1',
  paymentIntentId: 'pi_test_1',
  paymentStatus: 'succeeded',
  method: 'card',
  lines: [{ id: 'line-1', paidCents: 1000 }],
  paidServiceFeeCents: 0,
  previouslyRefundedServiceFeeCents: 0,
  policy: {
    rules: [{ throughDate: '2026-10-01', refundBps: 5000 }],
    afterLastBps: 0,
    serviceFeeRefund: 'none',
  },
  approvalThresholdCents: 400,
  refundApplicationFee: true,
};

function harness() {
  let recorded: CreditRefundResult | null = null;
  const reader = { load: vi.fn(() => Promise.resolve(source)) };
  const approvals = {
    isAuthorizedSecondApprover: vi.fn(() => Promise.resolve(true)),
  };
  const repository = {
    replay: vi.fn<CreditRefundRepository['replay']>(() =>
      Promise.resolve(recorded),
    ),
    apply: vi.fn<CreditRefundRepository['apply']>(() => {
      recorded = {
        refundId: 'refund-1',
        creditId: 'credit-1',
        amountCents: 500,
      };
      return Promise.resolve(recorded);
    }),
  };
  const service = new CreditRefundService(reader, approvals, repository);
  const request = {
    orgId: 'org-1',
    paymentId: 'payment-1',
    cancellationDate: '2026-09-26',
    requestedByAccountId: 'staff-1',
    approvedByAccountId: 'staff-2',
    idempotencyKey: randomUUID(),
    recipient: 'account' as const,
  };
  return { service, reader, approvals, repository, request };
}

describe('refund to credit policy', () => {
  it('applies the refund policy and replays without recalculating changed source balances', async () => {
    const test = harness();
    const first = await test.service.refund(test.request);
    expect(first).toEqual({
      refundId: 'refund-1',
      creditId: 'credit-1',
      amountCents: 500,
    });
    expect(test.repository.apply.mock.calls[0]?.[2]).toEqual({
      lines: [{ lineId: 'line-1', amountCents: 500 }],
      serviceFeeCents: 0,
      totalCents: 500,
      refundBps: 5000,
    });
    expect(await test.service.refund(test.request)).toEqual(first);
    expect(test.reader.load).toHaveBeenCalledOnce();
  });

  it('requires a separate approver above the threshold', async () => {
    const test = harness();
    await expect(
      test.service.refund({
        ...test.request,
        approvedByAccountId: 'staff-1',
      }),
    ).rejects.toThrow('separate finance approver');
    expect(test.repository.apply).not.toHaveBeenCalled();
  });
});
