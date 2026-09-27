import {
  calculatePricing,
  type PricingInput,
  type PricingSnapshot,
} from '@shared/algorithms/pricing';

export interface FrozenCheckoutPricing {
  orgId: string;
  checkoutId: string;
  sourceVersion: number;
  snapshot: PricingSnapshot;
}

/**
 * freeze runs in one withOrg transaction. It locks the open checkout and every
 * economic source row, loads PricingInput from the database, calculates once,
 * stores the snapshot and changes status to awaiting_payment before commit.
 * A replay returns the stored snapshot without invoking calculate again.
 */
export interface CheckoutPricingRepository {
  freeze(input: {
    orgId: string;
    checkoutId: string;
    idempotencyKey: string;
    calculate: (source: PricingInput) => PricingSnapshot;
  }): Promise<FrozenCheckoutPricing>;
}

export function assertPricingSnapshot(snapshot: PricingSnapshot): void {
  const amounts = [
    snapshot.subtotalCents,
    snapshot.discountCents,
    snapshot.aidCents,
    snapshot.creditAppliedCents,
    snapshot.serviceFeeCents,
    snapshot.taxCents,
    snapshot.invoiceTotalCents,
    snapshot.chargeNowCents,
  ];
  if (amounts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('Pricing snapshot has invalid cents');
  }
  const sum = snapshot.lines.reduce((total, line) => {
    if (!Number.isSafeInteger(line.amountCents)) {
      throw new RangeError('Pricing line has invalid cents');
    }
    return total + BigInt(line.amountCents);
  }, 0n);
  if (sum !== BigInt(snapshot.invoiceTotalCents)) {
    throw new Error('Pricing lines do not equal invoice total');
  }
  const total =
    BigInt(snapshot.subtotalCents) -
    BigInt(snapshot.discountCents) -
    BigInt(snapshot.aidCents) +
    BigInt(snapshot.serviceFeeCents) +
    BigInt(snapshot.taxCents);
  if (total !== BigInt(snapshot.invoiceTotalCents)) {
    throw new Error('Pricing components do not equal invoice total');
  }
  if (
    BigInt(snapshot.invoiceTotalCents) - BigInt(snapshot.creditAppliedCents) !==
    BigInt(snapshot.chargeNowCents)
  ) {
    throw new Error('Pricing charge does not reconcile with credit');
  }
}

export class CheckoutPricingService {
  constructor(private readonly repository: CheckoutPricingRepository) {}

  freeze(input: {
    orgId: string;
    checkoutId: string;
    idempotencyKey: string;
  }): Promise<FrozenCheckoutPricing> {
    return this.repository.freeze({
      ...input,
      calculate: (source) => {
        const snapshot = calculatePricing(source);
        assertPricingSnapshot(snapshot);
        return snapshot;
      },
    });
  }
}
