import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { allocate, formatMoney, percentOf } from './money';

describe('integer-cent money', () => {
  it('rounds percentages half up symmetrically', () => {
    expect(percentOf(1, 5_000)).toBe(1);
    expect(percentOf(-1, 5_000)).toBe(-1);
    expect(percentOf(3, 2_500)).toBe(1);
    expect(percentOf(10_001, 150)).toBe(150);
    expect(() => percentOf(Number.MAX_SAFE_INTEGER, 10_000)).not.toThrow();
    expect(() => percentOf(Number.MAX_SAFE_INTEGER, 20_000)).toThrow(
      RangeError,
    );
    expect(() => percentOf(1.5, 100)).toThrow(RangeError);
  });

  it('uses largest remainders with stable earlier-index ties', () => {
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocate(-10, [1, 1, 1])).toEqual([-4, -3, -3]);
    expect(allocate(7, [0, 3, 2])).toEqual([0, 4, 3]);
    expect(allocate(0, [0, 0])).toEqual([0, 0]);
    expect(() => allocate(1, [0, 0])).toThrow(RangeError);
  });

  it('always conserves cents for nonnegative integer weights', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc
          .array(fc.integer({ min: 0, max: 1_000 }), {
            minLength: 1,
            maxLength: 12,
          })
          .filter((weights) => weights.some((weight) => weight > 0)),
        (total, weights) => {
          const parts = allocate(total, weights);
          expect(parts.reduce((sum, part) => sum + part, 0)).toBe(total);
          expect(parts.every((part) => Number.isSafeInteger(part))).toBe(true);
          expect(
            parts.every(
              (part) => total === 0 || Math.sign(part) !== -Math.sign(total),
            ),
          ).toBe(true);
        },
      ),
    );
  });

  it('formats USD for display', () => {
    expect(formatMoney(123_456, 'en-US')).toBe('$1,234.56');
    expect(formatMoney(-1, 'en-US')).toBe('-$0.01');
    expect(formatMoney(Number.MAX_SAFE_INTEGER, 'en-US')).toBe(
      '$90,071,992,547,409.91',
    );
  });
});
