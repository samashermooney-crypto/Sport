import { describe, expect, it } from 'vitest';

import { proposeRefund, type RefundPolicy } from './refund-policy.js';

const policy: RefundPolicy = {
  rules: [
    { throughDate: '2026-08-31', refundBps: 10_000 },
    { throughDate: '2026-09-15', refundBps: 5000 },
  ],
  afterLastBps: 0,
  serviceFeeRefund: 'proportional',
};

describe('refund policy', () => {
  it('proposes per-line refunds by cancellation date and refunds fees proportionally', () => {
    const lines = [
      { id: 'registration', paidCents: 1000 },
      { id: 'uniform', paidCents: 500 },
    ];
    expect(proposeRefund(lines, 90, '2026-08-20', policy)).toMatchObject({
      totalCents: 1590,
      serviceFeeCents: 90,
      refundBps: 10_000,
    });
    expect(proposeRefund(lines, 90, '2026-09-10', policy)).toMatchObject({
      totalCents: 795,
      serviceFeeCents: 45,
      refundBps: 5000,
    });
    expect(proposeRefund(lines, 90, '2026-09-16', policy).totalCents).toBe(0);
  });

  it('does not refund a line or fee twice', () => {
    expect(
      proposeRefund(
        [{ id: 'r', paidCents: 1000, previouslyRefundedCents: 500 }],
        100,
        '2026-09-10',
        policy,
        50,
      ),
    ).toMatchObject({ totalCents: 0, serviceFeeCents: 0 });
  });

  it('allows policy to retain the service fee', () => {
    expect(
      proposeRefund([{ id: 'r', paidCents: 1000 }], 100, '2026-08-01', {
        ...policy,
        serviceFeeRefund: 'none',
      }).serviceFeeCents,
    ).toBe(0);
  });
});
