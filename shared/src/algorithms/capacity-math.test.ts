import { describe, expect, it } from 'vitest';

import {
  changeCapacity,
  holdExpiresAt,
  shouldKeepProcessingHold,
  type CapacityCounter,
} from './capacity-math.js';

const counters: CapacityCounter[] = [
  { subject: 'offering', id: 'o', capacity: 2, confirmed: 1, held: 0 },
  { subject: 'program', id: 'p', capacity: 2, confirmed: 1, held: 0 },
  { subject: 'division', id: 'd', capacity: 2, confirmed: 1, held: 0 },
];

describe('capacity math', () => {
  it('orders counters and carries hold through confirmation', () => {
    const held = changeCapacity(counters, 'hold');
    expect(held.map((counter) => counter.subject)).toEqual([
      'program',
      'division',
      'offering',
    ]);
    expect(
      changeCapacity(held, 'confirm').every(
        (counter) => counter.confirmed === 2 && counter.held === 0,
      ),
    ).toBe(true);
  });

  it('rejects oversell and underflow', () => {
    expect(() =>
      changeCapacity(changeCapacity(counters, 'hold'), 'hold'),
    ).toThrow();
    expect(() => changeCapacity(counters, 'release')).toThrow();
    const offering = counters[0];
    if (!offering) throw new Error('Test counter missing');
    expect(() =>
      changeCapacity([{ ...offering, capacity: 0 }], 'hold'),
    ).toThrow();
  });

  it('expires in 20 minutes, with activity extending up to 45 minutes', () => {
    expect(holdExpiresAt('2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')).toBe(
      '2026-09-01T10:20:00Z',
    );
    expect(holdExpiresAt('2026-09-01T10:00:00Z', '2026-09-01T10:30:00Z')).toBe(
      '2026-09-01T10:45:00Z',
    );
    expect(
      shouldKeepProcessingHold(
        'awaiting_payment',
        '2026-09-01T10:19:00Z',
        '2026-09-01T10:20:00Z',
      ),
    ).toBe(true);
    expect(
      shouldKeepProcessingHold(
        'draft',
        '2026-09-01T10:19:00Z',
        '2026-09-01T10:20:00Z',
      ),
    ).toBe(false);
  });

  it('withdraws confirmed capacity and rejects duplicate counters or reversed activity', () => {
    expect(
      changeCapacity(counters, 'withdraw').every(
        (counter) => counter.confirmed === 0,
      ),
    ).toBe(true);
    const first = counters[0];
    if (!first) throw new Error('Test counter missing');
    expect(() => changeCapacity([...counters, first], 'hold')).toThrow();
    expect(() =>
      holdExpiresAt('2026-09-01T10:00:00Z', '2026-09-01T09:59:00Z'),
    ).toThrow();
  });
});
