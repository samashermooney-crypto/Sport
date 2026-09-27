import type { PricingInput, PricingSnapshot } from '@shared/algorithms/pricing';
import { describe, expect, it, vi } from 'vitest';

import {
  assertPricingSnapshot,
  CheckoutPricingService,
  type CheckoutPricingRepository,
  type FrozenCheckoutPricing,
} from './pricing.js';

const source: PricingInput = {
  nowLocal: '2026-09-26T10:00:00',
  participants: [
    {
      id: 'participant-1',
      participantId: 'person-1',
      seasonId: 'season-1',
      offeringId: 'offering-1',
      priceCents: 10000,
    },
  ],
  addOns: [
    {
      id: 'shirt-1',
      parentLineId: 'participant-1',
      priceCents: 2000,
      taxable: true,
    },
  ],
  existingConfirmed: [],
  automaticRules: [],
  codes: [{ id: 'SAVE10', kind: 'fixed', value: 1000, stackable: true }],
  aid: [],
  applyCreditCents: 1000,
  serviceFee: { enabled: false },
  productTaxBps: 500,
};

describe('checkout pricing freeze', () => {
  it('calculates from repository-owned source once and replays exact cents', async () => {
    let frozen: FrozenCheckoutPricing | null = null;
    let current = source;
    const freeze = vi.fn<CheckoutPricingRepository['freeze']>((input) => {
      if (!frozen) {
        frozen = {
          orgId: input.orgId,
          checkoutId: input.checkoutId,
          sourceVersion: 7,
          snapshot: input.calculate(current),
        };
      }
      return Promise.resolve(frozen);
    });
    const service = new CheckoutPricingService({ freeze });
    const request = {
      orgId: 'org-1',
      checkoutId: 'checkout-1',
      idempotencyKey: 'same-request',
    };
    const first = await service.freeze(request);
    expect(first.snapshot.invoiceTotalCents).toBe(11092);
    expect(first.snapshot.chargeNowCents).toBe(10092);
    expect(first.snapshot.creditAppliedCents).toBe(1000);
    const participant = source.participants[0];
    if (!participant) throw new Error('Test participant missing');
    current = {
      ...source,
      participants: [{ ...participant, priceCents: 50000 }],
    };
    const replay = await service.freeze(request);
    expect(replay).toEqual(first);
    expect(freeze).toHaveBeenCalledTimes(2);
  });

  it('rejects snapshots with a missing line or mismatched credit', () => {
    const base: PricingSnapshot = {
      lines: [
        { id: 'item', kind: 'participant', amountCents: 100, taxable: false },
      ],
      subtotalCents: 100,
      discountCents: 0,
      aidCents: 0,
      creditAppliedCents: 0,
      serviceFeeCents: 0,
      taxCents: 0,
      invoiceTotalCents: 100,
      chargeNowCents: 100,
    };
    expect(() => {
      assertPricingSnapshot({ ...base, lines: [] });
    }).toThrow('lines do not equal');
    expect(() => {
      assertPricingSnapshot({ ...base, creditAppliedCents: 10 });
    }).toThrow('charge does not reconcile');
  });
});
