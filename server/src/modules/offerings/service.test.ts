import { describe, expect, it } from 'vitest';

import { offeringInputSchema } from './service.js';

const input = {
  programId: '00000000-0000-4000-8000-000000000001',
  name: 'Player registration',
  registrantRole: 'athlete' as const,
  priceCents: 10000,
};

describe('offering configuration', () => {
  it('validates early and late pricing windows and their order', () => {
    expect(
      offeringInputSchema.safeParse({
        ...input,
        pricing: {
          earlyPriceCents: 9000,
          earlyEndsAt: '2026-10-01T23:59:00-05:00',
          latePriceCents: 12000,
          lateStartsAt: '2026-11-01T00:00:00-05:00',
        },
      }).success,
    ).toBe(true);
    expect(
      offeringInputSchema.safeParse({
        ...input,
        pricing: { earlyPriceCents: 9000 },
      }).success,
    ).toBe(false);
    expect(
      offeringInputSchema.safeParse({
        ...input,
        pricing: {
          earlyPriceCents: 9000,
          earlyEndsAt: '2026-11-02T00:00:00-06:00',
          latePriceCents: 12000,
          lateStartsAt: '2026-11-01T00:00:00-05:00',
        },
      }).success,
    ).toBe(false);
  });

  it('validates unique configurable add-ons and size choices', () => {
    const valid = offeringInputSchema.parse({
      ...input,
      addOns: [
        {
          key: 'uniform-kit',
          name: 'Uniform kit',
          priceCents: 3500,
          required: true,
          options: [
            { key: 'youth-small', label: 'Youth small' },
            { key: 'youth-medium', label: 'Youth medium' },
          ],
        },
      ],
    });
    expect(valid.addOns).toMatchObject([
      {
        key: 'uniform-kit',
        required: true,
        options: [{ key: 'youth-small' }, { key: 'youth-medium' }],
      },
    ]);
    expect(
      offeringInputSchema.safeParse({
        ...input,
        addOns: [
          { key: 'uniform-kit', name: 'First', priceCents: 100 },
          { key: 'uniform-kit', name: 'Second', priceCents: 100 },
        ],
      }).success,
    ).toBe(false);
    expect(
      offeringInputSchema.safeParse({
        ...input,
        addOns: [
          {
            key: 'uniform-kit',
            name: 'Uniform kit',
            priceCents: 3500,
            options: [
              { key: 'small', label: 'Small' },
              { key: 'small', label: 'Small duplicate' },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
