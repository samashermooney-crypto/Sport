import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { applicationFee, serviceFee, serviceFeesForCharges } from './fees.js';

describe('fees', () => {
  it('caps the application fee below the charge', () => {
    expect(applicationFee(100, { bps: 500, fixedCents: 100 })).toBe(99);
    expect(applicationFee(0, { bps: 500, fixedCents: 100 })).toBe(0);
  });

  it('grosses up cover-costs service fees using integer arithmetic', () => {
    const config = {
      enabled: true as const,
      mode: 'cover_costs' as const,
      application: { bps: 150, fixedCents: 0 },
    };
    expect(serviceFee(10_000, config)).toBe(492);
    expect(serviceFeesForCharges([5_000, 5_000], config)).toEqual([262, 262]);
  });

  it('applies the same custom fee regardless of payment method', () => {
    const config = {
      enabled: true as const,
      mode: 'custom' as const,
      custom: { bps: 250, fixedCents: 50 },
    };
    expect(serviceFee(10_000, config)).toBe(300);
    expect(serviceFee(10_000, { enabled: false })).toBe(0);
  });

  it('never returns a negative fee for valid rates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 4000 }),
        (base, bps) => {
          expect(
            serviceFee(base, {
              enabled: true,
              mode: 'cover_costs',
              application: { bps, fixedCents: 0 },
              processing: { bps: 0, fixedCents: 0 },
            }),
          ).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('rejects impossible rates and negative amounts', () => {
    expect(() =>
      serviceFee(100, {
        enabled: true,
        mode: 'cover_costs',
        application: { bps: 10_000, fixedCents: 0 },
      }),
    ).toThrow();
    expect(() => serviceFee(-1, { enabled: false })).toThrow();
  });

  it('rejects grossed-up fees outside the safe integer range', () => {
    expect(() =>
      serviceFee(1, {
        enabled: true,
        mode: 'cover_costs',
        application: { bps: 0, fixedCents: Number.MAX_SAFE_INTEGER },
        processing: { bps: 0, fixedCents: Number.MAX_SAFE_INTEGER },
      }),
    ).toThrow('Fee exceeds the safe integer range');
  });
});
