import { describe, expect, it } from 'vitest';

import { quoteInstallmentPlan } from './installment-quotes.js';

const template = {
  deposit: { kind: 'fixed' as const, amountCents: 1000 },
  schedule: { kind: 'monthly' as const, count: 3, dayOfMonth: 15 },
  minAmountCents: 100,
};
const applicationRate = { bps: 150, fixedCents: 0 };

describe('installment fee quotes', () => {
  it('shows and reconciles a separate service fee on every charge', () => {
    const quote = quoteInstallmentPlan({
      totalDueCents: 10_001,
      template,
      todayLocal: '2026-01-31',
      applicationRate,
      serviceFee: {
        enabled: true,
        mode: 'cover_costs',
        application: applicationRate,
      },
    });
    expect(quote?.deposit).toMatchObject({
      dueOn: '2026-01-31',
      baseCents: 1000,
      serviceFeeCents: 78,
      amountCents: 1078,
    });
    expect(quote?.installments.map((item) => item.baseCents)).toEqual([
      3001, 3000, 3000,
    ]);
    expect(quote?.installments.map((item) => item.dueOn)).toEqual([
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
    ]);
    expect(quote?.serviceFeeTotalCents).toBe(588);
    expect(quote?.payableTotalCents).toBe(10_589);
    expect(
      quote &&
        [quote.deposit, ...quote.installments].reduce(
          (total, charge) => total + charge.amountCents,
          0,
        ),
    ).toBe(quote?.payableTotalCents);
  });

  it('rejects mismatched fee settings and unavailable fixed-date plans', () => {
    expect(() => {
      quoteInstallmentPlan({
        totalDueCents: 1000,
        template,
        todayLocal: '2026-01-31',
        applicationRate,
        serviceFee: {
          enabled: true,
          mode: 'cover_costs',
          application: { bps: 200, fixedCents: 0 },
        },
      });
    }).toThrow('disagree');
    expect(
      quoteInstallmentPlan({
        totalDueCents: 1000,
        template: {
          ...template,
          deposit: { kind: 'fixed', amountCents: 0 },
          schedule: { kind: 'fixed_dates', dates: ['2026-01-01'] },
        },
        todayLocal: '2026-02-01',
        applicationRate,
        serviceFee: { enabled: false },
      }),
    ).toBeNull();
  });
});
