import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  generateInstallments,
  reSpreadUnpaidInstallments,
} from './installments.js';

describe('installments', () => {
  it('charges a deposit and splits remaining cents to the first installment', () => {
    const plan = generateInstallments(
      10_001,
      {
        deposit: { kind: 'fixed', amountCents: 1000 },
        schedule: { kind: 'monthly', count: 3, dayOfMonth: 15 },
        minAmountCents: 100,
      },
      '2026-01-31',
    );
    expect(plan?.depositCents).toBe(1000);
    expect(plan?.installments.map((item) => item.amountCents)).toEqual([
      3001, 3000, 3000,
    ]);
    expect(plan?.installments.map((item) => item.dueOn)).toEqual([
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
    ]);
  });

  it('rolls past fixed-date amounts into the next future date', () => {
    const plan = generateInstallments(
      4000,
      {
        deposit: { kind: 'fixed', amountCents: 0 },
        schedule: {
          kind: 'fixed_dates',
          dates: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'],
        },
        minAmountCents: 100,
      },
      '2026-02-15',
    );
    expect(plan?.installments).toMatchObject([
      { dueOn: '2026-03-01', amountCents: 3000 },
      { dueOn: '2026-04-01', amountCents: 1000 },
    ]);
    expect(
      generateInstallments(
        1000,
        {
          deposit: { kind: 'fixed', amountCents: 0 },
          schedule: { kind: 'fixed_dates', dates: ['2026-01-01'] },
          minAmountCents: 1,
        },
        '2026-02-01',
      ),
    ).toBeNull();
  });

  it('schedules weekly charges every seven calendar days from the local checkout date', () => {
    const plan = generateInstallments(
      1001,
      {
        deposit: { kind: 'fixed', amountCents: 101 },
        schedule: { kind: 'weekly', count: 3 },
        minAmountCents: 100,
      },
      '2026-12-28',
    );
    expect(plan?.installments.map((item) => item.dueOn)).toEqual([
      '2027-01-04',
      '2027-01-11',
      '2027-01-18',
    ]);
    expect(plan?.installments.map((item) => item.amountCents)).toEqual([
      300, 300, 300,
    ]);
    expect(() =>
      generateInstallments(
        1000,
        {
          deposit: { kind: 'fixed', amountCents: 0 },
          schedule: { kind: 'weekly', count: 0 },
          minAmountCents: 1,
        },
        '2026-09-01',
      ),
    ).toThrow('Invalid weekly schedule');
  });

  it('reduces installment count to meet the minimum', () => {
    const plan = generateInstallments(
      1000,
      {
        deposit: { kind: 'percent', bps: 0 },
        schedule: { kind: 'monthly', count: 6, dayOfMonth: 31 },
        minAmountCents: 300,
      },
      '2026-01-15',
    );
    expect(plan?.installments.map((item) => item.amountCents)).toEqual([
      334, 333, 333,
    ]);
    expect(plan?.installments[0]?.dueOn).toBe('2026-02-28');
  });

  it('adjusts unpaid installments while preserving paid amounts', () => {
    const existing = [
      { dueOn: '2026-01-01', amountCents: 100, paidCents: 100 },
      { dueOn: '2026-02-01', amountCents: 100, paidCents: 50 },
      { dueOn: '2026-03-01', amountCents: 100, paidCents: 0 },
    ];
    expect(
      reSpreadUnpaidInstallments(existing, 3).map((item) => item.amountCents),
    ).toEqual([100, 102, 101]);
    expect(() => reSpreadUnpaidInstallments(existing, -200)).toThrow();
  });

  it('always reconciles generated totals exactly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 12 }),
        (total, count) => {
          const plan = generateInstallments(
            total,
            {
              deposit: { kind: 'percent', bps: 1500 },
              schedule: { kind: 'monthly', count, dayOfMonth: 10 },
              minAmountCents: 0,
            },
            '2026-09-01',
          );
          expect(
            (plan?.depositCents ?? 0) +
              (plan?.installments.reduce(
                (sum, item) => sum + item.amountCents,
                0,
              ) ?? 0),
          ).toBe(total);
        },
      ),
    );
  });

  it('merges fixed-date installments to satisfy a minimum', () => {
    const plan = generateInstallments(
      500,
      {
        deposit: { kind: 'fixed', amountCents: 0 },
        schedule: {
          kind: 'fixed_dates',
          dates: ['2026-10-01', '2026-11-01', '2026-12-01'],
        },
        minAmountCents: 200,
      },
      '2026-09-01',
    );
    expect(plan?.installments.map((item) => item.amountCents)).toEqual([500]);
  });

  it('rejects malformed schedules and protects already-paid installments', () => {
    expect(() =>
      generateInstallments(
        1000,
        {
          deposit: { kind: 'fixed', amountCents: 0 },
          schedule: { kind: 'monthly', count: 0, dayOfMonth: 10 },
          minAmountCents: 1,
        },
        '2026-09-01',
      ),
    ).toThrow();
    expect(() =>
      generateInstallments(
        1000,
        {
          deposit: { kind: 'fixed', amountCents: 0 },
          schedule: {
            kind: 'fixed_dates',
            dates: ['2026-11-01', '2026-10-01'],
          },
          minAmountCents: 1,
        },
        '2026-09-01',
      ),
    ).toThrow();
    expect(() =>
      reSpreadUnpaidInstallments(
        [{ dueOn: '2026-10-01', amountCents: 100, paidCents: 100 }],
        1,
      ),
    ).toThrow();
    expect(
      reSpreadUnpaidInstallments(
        [{ dueOn: '2026-10-01', amountCents: 100, paidCents: 100 }],
        0,
      ),
    ).toHaveLength(1);
  });
});
