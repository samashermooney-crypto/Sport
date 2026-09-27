import { Temporal } from '@js-temporal/polyfill';

import { allocate, percentOf } from '../money.js';

export type RefundPolicy = {
  rules: readonly { throughDate: string; refundBps: number }[];
  afterLastBps: number;
  serviceFeeRefund: 'proportional' | 'none';
};
export type RefundableLine = {
  id: string;
  paidCents: number;
  previouslyRefundedCents?: number;
};
export type ProposedRefund = {
  lines: { lineId: string; amountCents: number }[];
  serviceFeeCents: number;
  totalCents: number;
  refundBps: number;
};

export function proposeRefund(
  lines: readonly RefundableLine[],
  paidServiceFeeCents: number,
  cancellationDate: string,
  policy: RefundPolicy,
  previouslyRefundedServiceFeeCents = 0,
): ProposedRefund {
  Temporal.PlainDate.from(cancellationDate);
  if (!Number.isSafeInteger(paidServiceFeeCents) || paidServiceFeeCents < 0)
    throw new RangeError('Invalid service fee');
  if (
    !Number.isSafeInteger(previouslyRefundedServiceFeeCents) ||
    previouslyRefundedServiceFeeCents < 0 ||
    previouslyRefundedServiceFeeCents > paidServiceFeeCents
  )
    throw new RangeError('Invalid prior service fee refund');
  if (new Set(lines.map((line) => line.id)).size !== lines.length)
    throw new RangeError('Duplicate refund line');
  for (const rule of policy.rules) {
    Temporal.PlainDate.from(rule.throughDate);
    if (
      !Number.isSafeInteger(rule.refundBps) ||
      rule.refundBps < 0 ||
      rule.refundBps > 10_000
    )
      throw new RangeError('Refund percentage must be 0–10000 bps');
  }
  if (
    !Number.isSafeInteger(policy.afterLastBps) ||
    policy.afterLastBps < 0 ||
    policy.afterLastBps > 10_000
  )
    throw new RangeError('Refund percentage must be 0–10000 bps');
  const ordered = [...policy.rules].sort((a, b) =>
    a.throughDate.localeCompare(b.throughDate),
  );
  const bps =
    ordered.find((rule) => cancellationDate <= rule.throughDate)?.refundBps ??
    policy.afterLastBps;
  const proposed = lines.map((line) => {
    const previously = line.previouslyRefundedCents ?? 0;
    if (
      !Number.isSafeInteger(line.paidCents) ||
      !Number.isSafeInteger(previously) ||
      line.paidCents < 0 ||
      previously < 0 ||
      previously > line.paidCents
    )
      throw new RangeError('Invalid paid or refunded amount');
    return {
      lineId: line.id,
      amountCents: Math.max(0, percentOf(line.paidCents, bps) - previously),
    };
  });
  const paidTotal = lines.reduce((sum, line) => sum + line.paidCents, 0);
  const refundedTotal = proposed.reduce(
    (sum, line) => sum + line.amountCents,
    0,
  );
  const cumulativeRefunded =
    refundedTotal +
    lines.reduce((sum, line) => sum + (line.previouslyRefundedCents ?? 0), 0);
  const feeTarget =
    policy.serviceFeeRefund === 'none' || paidTotal === 0
      ? 0
      : (allocate(paidServiceFeeCents, [
          cumulativeRefunded,
          paidTotal - cumulativeRefunded,
        ])[0] ?? 0);
  const serviceFeeCents = Math.max(
    0,
    feeTarget - previouslyRefundedServiceFeeCents,
  );
  return {
    lines: proposed,
    serviceFeeCents,
    totalCents: refundedTotal + serviceFeeCents,
    refundBps: bps,
  };
}
