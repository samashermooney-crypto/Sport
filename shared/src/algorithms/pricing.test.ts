import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { calculatePricing, type PricingInput } from './pricing.js';

const base: PricingInput = {
  nowLocal: '2026-09-01T12:00:00',
  participants: [
    {
      id: 'p1',
      participantId: 'athlete1',
      seasonId: 's1',
      offeringId: 'o1',
      priceCents: 10_000,
    },
    {
      id: 'p2',
      participantId: 'athlete2',
      seasonId: 's1',
      offeringId: 'o1',
      priceCents: 8000,
    },
  ],
  addOns: [
    { id: 'shirt', parentLineId: 'p1', priceCents: 1000, taxable: true },
  ],
  existingConfirmed: [],
  siblingRule: { secondBps: 1000, thirdPlusBps: 2000 },
  automaticRules: [],
  codes: [],
  aid: [],
  applyCreditCents: 0,
  serviceFee: { enabled: false },
  productTaxBps: 800,
};

describe('pricing pipeline', () => {
  it('prices siblings by descending base price and taxes only products', () => {
    const snapshot = calculatePricing(base);
    expect(snapshot).toMatchObject({
      subtotalCents: 19_000,
      discountCents: 800,
      taxCents: 80,
      invoiceTotalCents: 18_280,
      chargeNowCents: 18_280,
    });
    expect(
      snapshot.lines.find((line) => line.sourceId === 'sibling'),
    ).toMatchObject({ parentLineId: 'p2', amountCents: -800 });
    expect(
      snapshot.lines.reduce((sum, line) => sum + line.amountCents, 0),
    ).toBe(snapshot.invoiceTotalCents);
  });

  it('counts existing confirmed registrations without changing their price', () => {
    const snapshot = calculatePricing({
      ...base,
      existingConfirmed: [
        { id: 'old', seasonId: 's1', basePriceCents: 12_000 },
      ],
    });
    expect(snapshot.discountCents).toBe(1000 + 1600);
    expect(snapshot.lines.some((line) => line.parentLineId === 'old')).toBe(
      false,
    );
  });

  it('applies one largest nonstackable automatic rule per line', () => {
    const snapshot = calculatePricing({
      ...base,
      siblingRule: undefined,
      automaticRules: [
        {
          id: 'small',
          priority: 1,
          stackable: false,
          kind: 'percent',
          value: 500,
        },
        {
          id: 'large',
          priority: 2,
          stackable: false,
          kind: 'percent',
          value: 1000,
        },
      ],
    });
    expect(snapshot.discountCents).toBe(1900);
    expect(snapshot.lines.some((line) => line.sourceId === 'small')).toBe(
      false,
    );
  });

  it('spreads fixed codes and aid, then applies credit and fee', () => {
    const snapshot = calculatePricing({
      ...base,
      siblingRule: undefined,
      codes: [{ id: 'save', stackable: false, kind: 'fixed', value: 1001 }],
      aid: [{ id: 'aid1', kind: 'fixed', value: 500 }],
      applyCreditCents: 2000,
      serviceFee: {
        enabled: true,
        mode: 'custom',
        custom: { bps: 100, fixedCents: 0 },
      },
    });
    expect(snapshot.discountCents).toBe(1001);
    expect(snapshot.aidCents).toBe(500);
    expect(snapshot.creditAppliedCents).toBe(2000);
    expect(snapshot.serviceFeeCents).toBe(155);
    expect(
      snapshot.lines.reduce((sum, line) => sum + line.amountCents, 0),
    ).toBe(snapshot.invoiceTotalCents);
    expect(snapshot.chargeNowCents).toBe(snapshot.invoiceTotalCents - 2000);
  });

  it('uses early and late windows only while active', () => {
    const first = base.participants[0];
    if (!first) throw new Error('Test participant missing');
    const snapshot = calculatePricing({
      ...base,
      participants: [
        {
          ...first,
          early: {
            startsAt: '2026-08-01',
            endsAt: '2026-09-10',
            priceCents: 5000,
          },
        },
      ],
      addOns: [],
      siblingRule: undefined,
    });
    expect(snapshot.subtotalCents).toBe(5000);
  });

  it('never creates negative lines beyond the base amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 50_000 }),
        (price, discount) => {
          const snapshot = calculatePricing({
            ...base,
            participants: [
              {
                id: 'p',
                participantId: 'a',
                seasonId: 's',
                offeringId: 'o',
                priceCents: price,
              },
            ],
            addOns: [],
            siblingRule: undefined,
            codes: [
              { id: 'code', stackable: false, kind: 'fixed', value: discount },
            ],
            productTaxBps: 0,
          });
          expect(snapshot.invoiceTotalCents).toBeGreaterThanOrEqual(0);
          expect(snapshot.discountCents).toBeLessThanOrEqual(price);
        },
      ),
    );
  });
});
