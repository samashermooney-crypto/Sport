import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  joiningTuition,
  tierChangeAdjustment,
  tuitionDuringPause,
  withdrawalRefund,
} from './proration.js';

const sessions = [
  '2026-09-02',
  '2026-09-09',
  '2026-09-16',
  '2026-09-23',
  '2026-09-30',
];

describe('academy proration', () => {
  it('charges mid-month by remaining sessions', () => {
    expect(
      joiningTuition(10_001, sessions, '2026-09-15', 'session_count'),
    ).toMatchObject({
      chargeCents: 6001,
      sessionsCharged: 3,
      sessionsScheduled: 5,
    });
    expect(
      joiningTuition(10_001, sessions, '2026-09-15', 'full_month').chargeCents,
    ).toBe(10_001);
  });

  it('can defer billing for arrivals after the twentieth', () => {
    expect(
      joiningTuition(10_000, sessions, '2026-09-21', 'no_charge_after_20th'),
    ).toMatchObject({ chargeCents: 0, firstBillNextMonth: true });
  });

  it('refunds only paid sessions after the notice period', () => {
    expect(withdrawalRefund(10_000, sessions, '2026-09-16')).toBe(4000);
    expect(withdrawalRefund(10_000, sessions, '2026-10-01')).toBe(0);
  });

  it('applies tier changes immediately or at the next billing date', () => {
    expect(
      tierChangeAdjustment(10_000, 15_000, sessions, '2026-09-16', 'immediate'),
    ).toBe(3000);
    expect(
      tierChangeAdjustment(15_000, 10_000, sessions, '2026-09-16', 'immediate'),
    ).toBe(-3000);
    expect(
      tierChangeAdjustment(
        10_000,
        15_000,
        sessions,
        '2026-09-16',
        'next_billing_date',
      ),
    ).toBe(0);
  });

  it('does not charge for fully paused months', () => {
    expect(
      tuitionDuringPause(10_000, sessions, '2026-09-01', '2026-09-30'),
    ).toBe(0);
    expect(
      tuitionDuringPause(10_000, sessions, '2026-09-10', '2026-09-20'),
    ).toBe(8000);
  });

  it('never charges more than monthly tuition', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 30 }),
        (monthly, day) => {
          const charge = joiningTuition(
            monthly,
            sessions,
            `2026-09-${String(day).padStart(2, '0')}`,
            'session_count',
          ).chargeCents;
          expect(charge).toBeGreaterThanOrEqual(0);
          expect(charge).toBeLessThanOrEqual(monthly);
        },
      ),
    );
  });
});
