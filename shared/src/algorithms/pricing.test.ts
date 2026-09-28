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

  it('applies sibling rules independently by household and offering scope', () => {
    const snapshot = calculatePricing({
      ...base,
      participants: [
        {
          id: 'h1-first',
          participantId: 'child-a',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-a',
          priceCents: 10_000,
        },
        {
          id: 'h1-second',
          participantId: 'child-b',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-a',
          priceCents: 8000,
        },
        {
          id: 'h2-first',
          participantId: 'child-c',
          householdId: 'house-b',
          seasonId: 'season-a',
          offeringId: 'offering-b',
          priceCents: 12_000,
        },
        {
          id: 'h2-second',
          participantId: 'child-d',
          householdId: 'house-b',
          seasonId: 'season-a',
          offeringId: 'offering-b',
          priceCents: 7000,
        },
      ],
      addOns: [],
      siblingRule: undefined,
      siblingRules: [
        {
          householdId: 'house-a',
          seasonId: 'season-a',
          secondBps: 1000,
          thirdPlusBps: 2000,
        },
        {
          householdId: 'house-b',
          seasonId: 'season-a',
          secondBps: 2000,
          thirdPlusBps: 3000,
        },
      ],
    });
    expect(
      snapshot.lines
        .filter((line) => line.sourceId === 'sibling')
        .map((line) => [line.parentLineId, line.amountCents]),
    ).toEqual([
      ['h1-second', -800],
      ['h2-second', -1400],
    ]);

    const scoped = calculatePricing({
      ...base,
      participants: [
        {
          id: 'eligible-child',
          participantId: 'child-a',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-a',
          priceCents: 10_000,
        },
        {
          id: 'out-of-scope-child',
          participantId: 'child-b',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-b',
          priceCents: 8000,
        },
      ],
      addOns: [],
      siblingRule: undefined,
      siblingRules: [
        {
          householdId: 'house-a',
          seasonId: 'season-a',
          secondBps: 1000,
          thirdPlusBps: 2000,
          eligibleOfferingIds: ['offering-a'],
        },
      ],
      existingConfirmed: [
        {
          id: 'prior-child',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-a',
          basePriceCents: 12_000,
        },
      ],
    });
    expect(
      scoped.lines.filter((line) => line.sourceId === 'sibling'),
    ).toMatchObject([{ parentLineId: 'eligible-child', amountCents: -1000 }]);
    expect(
      scoped.lines.some((line) => line.parentLineId === 'out-of-scope-child'),
    ).toBe(false);

    const byOffering = calculatePricing({
      ...base,
      participants: [
        {
          id: 'a-first',
          participantId: 'child-a',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-a',
          priceCents: 10_000,
        },
        {
          id: 'a-second',
          participantId: 'child-b',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-a',
          priceCents: 8000,
        },
        {
          id: 'b-first',
          participantId: 'child-c',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-b',
          priceCents: 12_000,
        },
        {
          id: 'b-second',
          participantId: 'child-d',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-b',
          priceCents: 7000,
        },
      ],
      addOns: [],
      siblingRule: undefined,
      siblingRules: [
        {
          householdId: 'house-a',
          seasonId: 'season-a',
          secondBps: 1000,
          thirdPlusBps: 2000,
          eligibleOfferingIds: ['offering-a'],
        },
        {
          householdId: 'house-a',
          seasonId: 'season-a',
          secondBps: 2000,
          thirdPlusBps: 3000,
          eligibleOfferingIds: ['offering-b'],
        },
      ],
    });
    expect(
      byOffering.lines
        .filter((line) => line.sourceId === 'sibling')
        .map((line) => [line.parentLineId, line.amountCents]),
    ).toEqual([
      ['a-second', -800],
      ['b-second', -1400],
    ]);
  });

  it('isolates aid by household and caps awards to remaining cents', () => {
    const snapshot = calculatePricing({
      ...base,
      participants: [
        {
          id: 'a1',
          participantId: 'child-a',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-a',
          priceCents: 10_000,
        },
        {
          id: 'b1',
          participantId: 'child-b',
          householdId: 'house-b',
          seasonId: 'season-a',
          offeringId: 'offering-b',
          priceCents: 10_000,
        },
        {
          id: 'a2',
          participantId: 'child-c',
          householdId: 'house-a',
          seasonId: 'season-a',
          offeringId: 'offering-a',
          priceCents: 10_000,
        },
      ],
      addOns: [],
      siblingRule: undefined,
      aid: [
        {
          id: 'house-a-percent',
          kind: 'percent',
          value: 5000,
          householdId: 'house-a',
          remainingCents: 7000,
        },
        {
          id: 'house-b-fixed',
          kind: 'fixed',
          value: 8000,
          householdId: 'house-b',
          remainingCents: 2000,
        },
      ],
    });
    const aidBySource = new Map<string, number>();
    for (const line of snapshot.lines.filter((item) => item.kind === 'aid'))
      aidBySource.set(
        line.sourceId ?? '',
        (aidBySource.get(line.sourceId ?? '') ?? 0) - line.amountCents,
      );
    expect(aidBySource).toEqual(
      new Map([
        ['house-a-percent', 7000],
        ['house-b-fixed', 2000],
      ]),
    );
    expect(snapshot.aidCents).toBe(9000);
    expect(
      snapshot.lines
        .filter((line) => line.sourceId === 'house-a-percent')
        .map((line) => [line.parentLineId, line.amountCents]),
    ).toEqual([
      ['a1', -3500],
      ['a2', -3500],
    ]);
    expect(
      snapshot.lines.find((line) => line.sourceId === 'house-b-fixed'),
    ).toMatchObject({ parentLineId: 'b1', amountCents: -2000 });
    expect(() =>
      calculatePricing({
        ...base,
        participants: [
          {
            id: 'a',
            participantId: 'child-a',
            householdId: 'house-a',
            seasonId: 'season-a',
            offeringId: 'offering-a',
            priceCents: 10_000,
          },
          {
            id: 'b',
            participantId: 'child-b',
            householdId: 'house-b',
            seasonId: 'season-a',
            offeringId: 'offering-b',
            priceCents: 10_000,
          },
        ],
        addOns: [],
        siblingRule: undefined,
        aid: [{ id: 'unscoped', kind: 'fixed', value: 5000 }],
      }),
    ).toThrow('Household-scoped aid awards');
  });

  it('rejects unscoped or malformed household pricing inputs', () => {
    const participants = [
      {
        id: 'a',
        participantId: 'child-a',
        householdId: 'house-a',
        seasonId: 'season-a',
        offeringId: 'offering-a',
        priceCents: 10_000,
      },
      {
        id: 'b',
        participantId: 'child-b',
        householdId: 'house-b',
        seasonId: 'season-a',
        offeringId: 'offering-b',
        priceCents: 10_000,
      },
    ];
    const firstParticipant = participants[0];
    if (!firstParticipant) throw new Error('First participant is missing');
    const input = { ...base, participants, addOns: [], siblingRule: undefined };
    const rule = {
      householdId: 'house-a',
      seasonId: 'season-a',
      secondBps: 1000,
      thirdPlusBps: 2000,
    };
    expect(() =>
      calculatePricing({ ...input, siblingRule: base.siblingRule }),
    ).toThrow('Household-scoped sibling rules are required');
    expect(() =>
      calculatePricing({
        ...input,
        siblingRules: [rule, rule],
      }),
    ).toThrow('Overlapping household sibling rule scope');
    expect(() =>
      calculatePricing({
        ...input,
        participants: [
          firstParticipant,
          {
            id: 'b',
            participantId: 'child-b',
            seasonId: 'season-a',
            offeringId: 'offering-b',
            priceCents: 10_000,
          },
        ],
        siblingRules: [rule],
      }),
    ).toThrow('Household identity is required');
    expect(() =>
      calculatePricing({
        ...base,
        aid: [
          {
            id: 'wrong-household',
            kind: 'fixed',
            value: 100,
            householdId: 'not-in-cart',
            remainingCents: 100,
          },
        ],
      }),
    ).toThrow('Aid household is not represented');
    expect(() =>
      calculatePricing({
        ...base,
        participants: [firstParticipant],
        addOns: [],
        siblingRule: undefined,
        aid: [
          {
            id: 'uncapped-household-award',
            kind: 'fixed',
            value: 100,
            householdId: 'house-a',
          },
        ],
      }),
    ).toThrow('Household-scoped aid requires a remaining-cent cap');
    expect(() =>
      calculatePricing({
        ...base,
        aid: [
          {
            id: 'negative-cap',
            kind: 'fixed',
            value: 100,
            remainingCents: -1,
          },
        ],
      }),
    ).toThrow('remaining aid must be non-negative integer cents');
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
