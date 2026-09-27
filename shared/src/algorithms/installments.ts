import { Temporal } from '@js-temporal/polyfill';

import { allocate, percentOf } from '../money.js';

export type InstallmentTemplate = {
  deposit:
    { kind: 'fixed'; amountCents: number } | { kind: 'percent'; bps: number };
  schedule:
    | { kind: 'fixed_dates'; dates: readonly string[] }
    | { kind: 'monthly'; count: number; dayOfMonth: number }
    | { kind: 'weekly'; count: number };
  minAmountCents: number;
};
export type PlannedInstallment = {
  dueOn: string;
  amountCents: number;
  paidCents: number;
};
export type InstallmentPlan = {
  depositCents: number;
  installments: PlannedInstallment[];
};

function cents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be non-negative integer cents`);
}

function monthlyDate(
  today: Temporal.PlainDate,
  offset: number,
  day: number,
): string {
  const month = Temporal.PlainYearMonth.from({
    year: today.year,
    month: today.month,
  }).add({ months: offset });
  return Temporal.PlainDate.from({
    year: month.year,
    month: month.month,
    day: Math.min(day, month.daysInMonth),
  }).toString();
}

export function generateInstallments(
  totalDueCents: number,
  template: InstallmentTemplate,
  todayLocal: string,
): InstallmentPlan | null {
  cents(totalDueCents, 'total due');
  cents(template.minAmountCents, 'minimum installment');
  const today = Temporal.PlainDate.from(todayLocal);
  const deposit =
    template.deposit.kind === 'fixed'
      ? template.deposit.amountCents
      : percentOf(totalDueCents, template.deposit.bps);
  cents(deposit, 'deposit');
  const depositCents = Math.min(totalDueCents, deposit);
  const remaining = totalDueCents - depositCents;
  if (remaining === 0) return { depositCents, installments: [] };
  let dates: string[];
  if (template.schedule.kind === 'monthly') {
    const { count, dayOfMonth } = template.schedule;
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      !Number.isSafeInteger(dayOfMonth) ||
      dayOfMonth < 1 ||
      dayOfMonth > 31
    )
      throw new RangeError('Invalid monthly schedule');
    dates = Array.from({ length: count }, (_, index) =>
      monthlyDate(today, index + 1, dayOfMonth),
    );
  } else if (template.schedule.kind === 'weekly') {
    const { count } = template.schedule;
    if (!Number.isSafeInteger(count) || count < 1)
      throw new RangeError('Invalid weekly schedule');
    dates = Array.from({ length: count }, (_, index) =>
      today.add({ weeks: index + 1 }).toString(),
    );
  } else {
    dates = [...template.schedule.dates];
    if (
      !dates.length ||
      dates.some((date, index) => index > 0 && date <= (dates[index - 1] ?? ''))
    )
      throw new RangeError('Fixed dates must be strictly ascending');
    dates.forEach((date) => {
      Temporal.PlainDate.from(date);
    });
  }
  let amounts = allocate(
    remaining,
    dates.map(() => 1),
  );
  if (template.schedule.kind === 'fixed_dates') {
    const firstFuture = dates.findIndex((date) => date >= todayLocal);
    if (firstFuture === -1) return null;
    const rolled = amounts
      .slice(0, firstFuture)
      .reduce((sum, value) => sum + value, 0);
    dates = dates.slice(firstFuture);
    amounts = amounts.slice(firstFuture);
    if (amounts[0] !== undefined) amounts[0] += rolled;
  }
  while (
    dates.length > 1 &&
    amounts.some((amount) => amount < template.minAmountCents)
  ) {
    const removed = amounts.pop();
    dates.pop();
    if (removed === undefined) throw new Error('Installment amount missing');
    if (template.schedule.kind === 'fixed_dates') {
      const previous = amounts.length - 1;
      if (amounts[previous] === undefined)
        throw new Error('Installment amount missing');
      amounts[previous] += removed;
    } else
      amounts = allocate(
        remaining,
        dates.map(() => 1),
      );
  }
  if (amounts.some((amount) => amount < template.minAmountCents)) return null;
  return {
    depositCents,
    installments: dates.map((dueOn, index) => ({
      dueOn,
      amountCents: amounts[index] ?? 0,
      paidCents: 0,
    })),
  };
}

export function reSpreadUnpaidInstallments(
  existing: readonly PlannedInstallment[],
  deltaCents: number,
): PlannedInstallment[] {
  if (!Number.isSafeInteger(deltaCents))
    throw new RangeError('Delta must be integer cents');
  const unpaidIndexes = existing.flatMap((item, index) =>
    item.paidCents < item.amountCents ? [index] : [],
  );
  if (!unpaidIndexes.length) {
    if (deltaCents !== 0) throw new RangeError('No unpaid installments remain');
    return existing.map((item) => ({ ...item }));
  }
  const changes = allocate(
    deltaCents,
    unpaidIndexes.map(() => 1),
  );
  const next = existing.map((item) => ({ ...item }));
  unpaidIndexes.forEach((index, position) => {
    const item = next[index];
    if (!item) throw new Error('Installment missing');
    item.amountCents += changes[position] ?? 0;
    if (item.amountCents < item.paidCents)
      throw new RangeError(
        'Adjustment would reduce installment below its paid amount',
      );
  });
  return next;
}
