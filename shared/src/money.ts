const basisPoints = 10_000n;

function safeInteger(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
  return BigInt(value);
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Money result exceeds the safe integer range');
  }
  return result;
}

export function percentOf(amountCents: number, bps: number): number {
  const amount = safeInteger(amountCents, 'amountCents');
  const rate = safeInteger(bps, 'bps');
  if (rate < 0n) throw new RangeError('bps must be non-negative');
  const absolute = amount < 0n ? -amount : amount;
  const rounded = (absolute * rate + basisPoints / 2n) / basisPoints;
  return safeNumber(amount < 0n ? -rounded : rounded);
}

export function allocate(
  totalCents: number,
  weights: readonly number[],
): number[] {
  const total = safeInteger(totalCents, 'totalCents');
  if (weights.length === 0) {
    if (total === 0n) return [];
    throw new RangeError('weights must not be empty for a nonzero total');
  }
  const integerWeights = weights.map((weight) => {
    const value = safeInteger(weight, 'weight');
    if (value < 0n) throw new RangeError('weights must be non-negative');
    return value;
  });
  const weightTotal = integerWeights.reduce((sum, weight) => sum + weight, 0n);
  if (weightTotal === 0n) {
    if (total === 0n) return weights.map(() => 0);
    throw new RangeError('at least one weight must be positive');
  }

  const absolute = total < 0n ? -total : total;
  const shares = integerWeights.map((weight, index) => {
    const scaled = absolute * weight;
    return {
      index,
      quotient: scaled / weightTotal,
      remainder: scaled % weightTotal,
    };
  });
  const assigned = shares.reduce((sum, share) => sum + share.quotient, 0n);
  let remainder = absolute - assigned;
  const ranked = [...shares].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const share of ranked) {
    if (remainder === 0n) break;
    const recipient = shares[share.index];
    if (!recipient) throw new Error('Allocation index is missing');
    recipient.quotient += 1n;
    remainder -= 1n;
  }
  return shares.map(({ quotient }) =>
    safeNumber(total < 0n ? -quotient : quotient),
  );
}

export function formatMoney(amountCents: number, locale: string): string {
  const amount = safeInteger(amountCents, 'amountCents');
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / 100n;
  const displayWhole = amount < 0n ? (whole === 0n ? -0 : -whole) : whole;
  const cents = String(absolute % 100n).padStart(2, '0');
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' })
    .formatToParts(displayWhole)
    .map((part) => (part.type === 'fraction' ? cents : part.value))
    .join('');
}
