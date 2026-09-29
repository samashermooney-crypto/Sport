import { allocate, percentOf } from '../money.js';

import { serviceFee, type ServiceFeeConfig } from './fees.js';

export type PriceWindow = {
  startsAt: string;
  endsAt: string;
  priceCents: number;
};
export type ParticipantPrice = {
  id: string;
  participantId: string;
  householdId?: string;
  seasonId: string;
  offeringId: string;
  priceCents: number;
  early?: PriceWindow;
  late?: PriceWindow;
};
export type AddOnPrice = {
  id: string;
  parentLineId: string;
  priceCents: number;
  taxable: boolean;
};
export type ExistingRegistration = {
  id: string;
  householdId?: string;
  seasonId: string;
  offeringId?: string;
  basePriceCents: number;
};
export type SiblingDiscountRule = {
  householdId: string;
  seasonId: string;
  secondBps: number;
  thirdPlusBps: number;
  eligibleOfferingIds?: readonly string[];
};
export type DiscountRule = {
  id: string;
  priority: number;
  stackable: boolean;
  kind: 'percent' | 'fixed';
  value: number;
  eligibleOfferingIds?: readonly string[];
};
export type DiscountCode = {
  id: string;
  stackable: boolean;
  kind: 'percent' | 'fixed';
  value: number;
  eligibleOfferingIds?: readonly string[];
};
export type AidAward = {
  id: string;
  kind: 'percent' | 'fixed';
  value: number;
  householdId?: string;
  /** Maximum cents this award may apply in this checkout after prior usage. */
  remainingCents?: number;
  eligibleOfferingIds?: readonly string[];
};
export type PriceLine = {
  id: string;
  kind: 'participant' | 'add_on' | 'discount' | 'aid' | 'service_fee' | 'tax';
  amountCents: number;
  parentLineId?: string;
  sourceId?: string;
  taxable: boolean;
};
export type PricingInput = {
  nowLocal: string;
  participants: readonly ParticipantPrice[];
  addOns: readonly AddOnPrice[];
  existingConfirmed: readonly ExistingRegistration[];
  siblingRule?: { secondBps: number; thirdPlusBps: number } | undefined;
  siblingRules?: readonly SiblingDiscountRule[];
  automaticRules: readonly DiscountRule[];
  codes: readonly DiscountCode[];
  aid: readonly AidAward[];
  applyCreditCents: number;
  serviceFee: ServiceFeeConfig;
  productTaxBps: number;
};
export type PricingSnapshot = {
  lines: PriceLine[];
  subtotalCents: number;
  discountCents: number;
  aidCents: number;
  creditAppliedCents: number;
  serviceFeeCents: number;
  taxCents: number;
  invoiceTotalCents: number;
  chargeNowCents: number;
};

function money(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be non-negative integer cents`);
}

function priceAt(participant: ParticipantPrice, now: string): number {
  const active = (window: PriceWindow | undefined): boolean =>
    !!window && now >= window.startsAt && now <= window.endsAt;
  const price = active(participant.early)
    ? participant.early?.priceCents
    : active(participant.late)
      ? participant.late?.priceCents
      : participant.priceCents;
  if (price === undefined) throw new Error('Participant price missing');
  money(price, 'participant price');
  return price;
}

function discountAmount(
  kind: 'percent' | 'fixed',
  value: number,
  base: number,
): number {
  money(value, 'discount value');
  return Math.min(base, kind === 'percent' ? percentOf(base, value) : value);
}

export function calculatePricing(input: PricingInput): PricingSnapshot {
  money(input.applyCreditCents, 'credit');
  money(input.productTaxBps, 'tax rate');
  if (input.codes.length > 1 && input.codes.some((code) => !code.stackable))
    throw new RangeError('Only stackable codes may be combined');
  const lines: PriceLine[] = [];
  const participantById = new Map(
    input.participants.map((item) => [item.id, item]),
  );
  if (participantById.size !== input.participants.length)
    throw new RangeError('Duplicate participant line ID');
  const householdIds = new Set(
    input.participants.flatMap((item) =>
      item.householdId ? [item.householdId] : [],
    ),
  );
  if (input.siblingRule && (input.siblingRules?.length ?? 0) > 0)
    throw new RangeError('Choose either legacy or household sibling rules');
  const hasUnidentifiedParticipants = input.participants.some(
    (item) => !item.householdId,
  );
  if (
    input.siblingRule &&
    (householdIds.size > 1 ||
      (householdIds.size === 1 && hasUnidentifiedParticipants))
  )
    throw new RangeError(
      'Household-scoped sibling rules are required for mixed-household checkouts',
    );
  if (
    input.siblingRules?.length &&
    (input.participants.some((item) => !item.householdId) ||
      input.existingConfirmed.some((item) => !item.householdId))
  )
    throw new RangeError(
      'Household identity is required for scoped sibling pricing',
    );
  if (
    (householdIds.size > 1 ||
      (householdIds.size === 1 && hasUnidentifiedParticipants)) &&
    input.aid.some(
      (award) => !award.householdId || award.remainingCents === undefined,
    )
  )
    throw new RangeError(
      'Household-scoped aid awards with remaining-cent caps are required for mixed-household checkouts',
    );
  if (
    input.aid.some(
      (award) =>
        award.householdId !== undefined && award.remainingCents === undefined,
    )
  )
    throw new RangeError('Household-scoped aid requires a remaining-cent cap');
  if (
    input.aid.some(
      (award) =>
        award.householdId &&
        !input.participants.some(
          (participant) => participant.householdId === award.householdId,
        ),
    )
  )
    throw new RangeError('Aid household is not represented in checkout');
  const siblingScopes = new Map<string, SiblingDiscountRule[]>();
  for (const rule of input.siblingRules ?? []) {
    const scope = `${rule.householdId}:${rule.seasonId}`;
    if (
      rule.eligibleOfferingIds &&
      new Set(rule.eligibleOfferingIds).size !== rule.eligibleOfferingIds.length
    )
      throw new RangeError('Duplicate sibling-eligible offering');
    const sameHouseholdSeason = siblingScopes.get(scope) ?? [];
    if (
      sameHouseholdSeason.some((existing) => {
        if (!existing.eligibleOfferingIds || !rule.eligibleOfferingIds)
          return true;
        const existingIds = new Set(existing.eligibleOfferingIds);
        return rule.eligibleOfferingIds.some((id) => existingIds.has(id));
      })
    )
      throw new RangeError('Overlapping household sibling rule scope');
    sameHouseholdSeason.push(rule);
    siblingScopes.set(scope, sameHouseholdSeason);
    if (
      rule.eligibleOfferingIds &&
      input.existingConfirmed.some(
        (existing) =>
          existing.householdId === rule.householdId &&
          existing.seasonId === rule.seasonId &&
          !existing.offeringId,
      )
    )
      throw new RangeError(
        'Offering identity is required for scoped existing registrations',
      );
  }
  for (const item of input.participants)
    lines.push({
      id: item.id,
      kind: 'participant',
      amountCents: priceAt(item, input.nowLocal),
      taxable: false,
    });
  for (const item of input.addOns) {
    if (!participantById.has(item.parentLineId))
      throw new RangeError('Add-on parent does not exist');
    money(item.priceCents, 'add-on price');
    lines.push({
      id: item.id,
      kind: 'add_on',
      amountCents: item.priceCents,
      parentLineId: item.parentLineId,
      taxable: item.taxable,
    });
  }
  if (new Set(lines.map((line) => line.id)).size !== lines.length)
    throw new RangeError('Duplicate price line ID');
  const baseLines = [...lines];
  const remaining = new Map(
    baseLines.map((line) => [line.id, line.amountCents]),
  );
  const offering = (line: PriceLine): string | undefined =>
    participantById.get(
      line.kind === 'add_on' ? (line.parentLineId ?? '') : line.id,
    )?.offeringId;
  const eligible = (line: PriceLine, ids?: readonly string[]): boolean =>
    !ids || ids.includes(offering(line) ?? '');
  const apply = (
    kind: 'discount' | 'aid',
    sourceId: string,
    parent: PriceLine,
    amount: number,
  ): void => {
    const used = Math.min(remaining.get(parent.id) ?? 0, amount);
    if (used <= 0) return;
    lines.push({
      id: `${kind}:${sourceId}:${parent.id}:${String(lines.length)}`,
      kind,
      amountCents: -used,
      parentLineId: parent.id,
      sourceId,
      taxable: false,
    });
    remaining.set(parent.id, (remaining.get(parent.id) ?? 0) - used);
  };
  if (input.siblingRule) {
    const { secondBps, thirdPlusBps } = input.siblingRule;
    money(secondBps, 'sibling second bps');
    money(thirdPlusBps, 'sibling third bps');
    const seasons = new Set(input.participants.map((item) => item.seasonId));
    for (const seasonId of seasons) {
      const current = input.participants
        .filter((item) => item.seasonId === seasonId)
        .map((item) => ({
          id: item.id,
          price: remaining.get(item.id) ?? 0,
          current: true,
        }));
      const existing = input.existingConfirmed
        .filter((item) => item.seasonId === seasonId)
        .map((item) => ({
          id: item.id,
          price: item.basePriceCents,
          current: false,
        }));
      const ranked = [...current, ...existing].sort(
        (a, b) => b.price - a.price || a.id.localeCompare(b.id),
      );
      ranked.forEach((item, index) => {
        const line = baseLines.find((candidate) => candidate.id === item.id);
        if (item.current && line && index > 0)
          apply(
            'discount',
            'sibling',
            line,
            percentOf(line.amountCents, index === 1 ? secondBps : thirdPlusBps),
          );
      });
    }
  }
  for (const rule of input.siblingRules ?? []) {
    money(rule.secondBps, 'sibling second bps');
    money(rule.thirdPlusBps, 'sibling third bps');
    const current = baseLines
      .filter((line) => {
        const item = participantById.get(line.id);
        return (
          item?.householdId === rule.householdId &&
          item.seasonId === rule.seasonId &&
          (!rule.eligibleOfferingIds ||
            rule.eligibleOfferingIds.includes(item.offeringId))
        );
      })
      .map((line) => ({
        id: line.id,
        price: line.amountCents,
        current: true as const,
        line,
      }));
    const existing = input.existingConfirmed
      .filter(
        (item) =>
          item.householdId === rule.householdId &&
          item.seasonId === rule.seasonId &&
          (!rule.eligibleOfferingIds ||
            (item.offeringId !== undefined &&
              rule.eligibleOfferingIds.includes(item.offeringId))),
      )
      .map((item) => ({
        id: item.id,
        price: item.basePriceCents,
        current: false as const,
      }));
    const ranked = [...current, ...existing].sort(
      (a, b) => b.price - a.price || a.id.localeCompare(b.id),
    );
    ranked.forEach((item, index) => {
      if (item.current && index > 0)
        apply(
          'discount',
          'sibling',
          item.line,
          percentOf(
            item.line.amountCents,
            index === 1 ? rule.secondBps : rule.thirdPlusBps,
          ),
        );
    });
  }
  const rules = [...input.automaticRules].sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  );
  const nonstackable = new Map<string, { ruleId: string; amount: number }>();
  for (const rule of rules) {
    for (const line of baseLines.filter((item) =>
      eligible(item, rule.eligibleOfferingIds),
    )) {
      const amount = discountAmount(
        rule.kind,
        rule.value,
        remaining.get(line.id) ?? 0,
      );
      if (rule.stackable) apply('discount', rule.id, line, amount);
      else if (amount > (nonstackable.get(line.id)?.amount ?? 0))
        nonstackable.set(line.id, { ruleId: rule.id, amount });
    }
  }
  for (const [lineId, chosen] of nonstackable) {
    const line = baseLines.find((item) => item.id === lineId);
    if (line) apply('discount', chosen.ruleId, line, chosen.amount);
  }
  for (const code of input.codes) {
    money(code.value, 'discount code value');
    const matches = baseLines.filter(
      (line) =>
        eligible(line, code.eligibleOfferingIds) &&
        (remaining.get(line.id) ?? 0) > 0,
    );
    if (code.kind === 'percent')
      matches.forEach((line) => {
        apply(
          'discount',
          code.id,
          line,
          discountAmount('percent', code.value, remaining.get(line.id) ?? 0),
        );
      });
    else {
      const weights = matches.map((line) => remaining.get(line.id) ?? 0);
      const amounts = weights.length
        ? allocate(
            Math.min(
              code.value,
              weights.reduce((a, b) => a + b, 0),
            ),
            weights,
          )
        : [];
      matches.forEach((line, index) => {
        apply('discount', code.id, line, amounts[index] ?? 0);
      });
    }
  }
  for (const award of input.aid) {
    money(award.value, 'aid value');
    if (award.remainingCents !== undefined)
      money(award.remainingCents, 'remaining aid');
    const matches = baseLines.filter(
      (line) =>
        eligible(line, award.eligibleOfferingIds) &&
        (!award.householdId ||
          participantById.get(
            line.kind === 'add_on' ? (line.parentLineId ?? '') : line.id,
          )?.householdId === award.householdId) &&
        (remaining.get(line.id) ?? 0) > 0,
    );
    if (award.kind === 'percent')
      (() => {
        const amounts = matches.map((line) =>
          discountAmount('percent', award.value, remaining.get(line.id) ?? 0),
        );
        const proposed = amounts.reduce((sum, amount) => sum + amount, 0);
        const capped = Math.min(award.remainingCents ?? proposed, proposed);
        const allocations =
          capped < proposed ? allocate(capped, amounts) : amounts;
        matches.forEach((line, index) => {
          apply('aid', award.id, line, allocations[index] ?? 0);
        });
      })();
    else {
      const weights = matches.map((line) => remaining.get(line.id) ?? 0);
      const available = weights.reduce((sum, amount) => sum + amount, 0);
      const amounts = weights.length
        ? allocate(
            Math.min(
              award.value,
              award.remainingCents ?? award.value,
              available,
            ),
            weights,
          )
        : [];
      matches.forEach((line, index) => {
        apply('aid', award.id, line, amounts[index] ?? 0);
      });
    }
  }
  const subtotalCents = baseLines.reduce(
    (sum, line) => sum + line.amountCents,
    0,
  );
  const discountCents = -lines
    .filter((line) => line.kind === 'discount')
    .reduce((sum, line) => sum + line.amountCents, 0);
  const aidCents = -lines
    .filter((line) => line.kind === 'aid')
    .reduce((sum, line) => sum + line.amountCents, 0);
  const beforeFee = subtotalCents - discountCents - aidCents;
  const creditAppliedCents = Math.min(input.applyCreditCents, beforeFee);
  const serviceFeeCents = serviceFee(
    beforeFee - creditAppliedCents,
    input.serviceFee,
  );
  if (serviceFeeCents)
    lines.push({
      id: 'service_fee',
      kind: 'service_fee',
      amountCents: serviceFeeCents,
      taxable: false,
    });
  const taxCents = baseLines
    .filter((line) => line.taxable)
    .reduce(
      (sum, line) =>
        sum + percentOf(remaining.get(line.id) ?? 0, input.productTaxBps),
      0,
    );
  if (taxCents)
    lines.push({
      id: 'tax',
      kind: 'tax',
      amountCents: taxCents,
      taxable: false,
    });
  const invoiceTotalCents = beforeFee + serviceFeeCents + taxCents;
  return {
    lines,
    subtotalCents,
    discountCents,
    aidCents,
    creditAppliedCents,
    serviceFeeCents,
    taxCents,
    invoiceTotalCents,
    chargeNowCents: invoiceTotalCents - creditAppliedCents,
  };
}
