import { Temporal } from '@js-temporal/polyfill';

import { allocate } from '../money.js';

export type JoinProration = {
  chargeCents: number;
  firstBillNextMonth: boolean;
  sessionsCharged: number;
  sessionsScheduled: number;
};
export type ProrationSetting =
  'session_count' | 'full_month' | 'no_charge_after_20th';

function validateSessions(sessions: readonly string[]): string[] {
  const ordered = [...sessions].sort();
  if (new Set(ordered).size !== ordered.length)
    throw new RangeError('Duplicate scheduled session');
  ordered.forEach((session) => {
    Temporal.PlainDate.from(session);
  });
  return ordered;
}

function cents(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Tuition must be non-negative integer cents');
}

function prorated(
  amountCents: number,
  included: number,
  total: number,
): number {
  cents(amountCents);
  if (
    !Number.isSafeInteger(included) ||
    !Number.isSafeInteger(total) ||
    included < 0 ||
    total < 0 ||
    included > total
  )
    throw new RangeError('Invalid session counts');
  if (total === 0) return 0;
  return allocate(amountCents, [included, total - included])[0] ?? 0;
}

export function joiningTuition(
  monthlyCents: number,
  scheduledSessions: readonly string[],
  joinsOn: string,
  setting: ProrationSetting,
): JoinProration {
  const sessions = validateSessions(scheduledSessions);
  const join = Temporal.PlainDate.from(joinsOn);
  const remaining = sessions.filter((session) => session >= joinsOn).length;
  if (setting === 'no_charge_after_20th' && join.day > 20)
    return {
      chargeCents: 0,
      firstBillNextMonth: true,
      sessionsCharged: 0,
      sessionsScheduled: sessions.length,
    };
  const chargeCents =
    remaining === 0
      ? 0
      : setting === 'full_month'
        ? monthlyCents
        : prorated(monthlyCents, remaining, sessions.length);
  cents(chargeCents);
  return {
    chargeCents,
    firstBillNextMonth: false,
    sessionsCharged: remaining,
    sessionsScheduled: sessions.length,
  };
}

export function withdrawalRefund(
  paidPeriodCents: number,
  scheduledSessions: readonly string[],
  noticeEndsOn: string,
): number {
  const sessions = validateSessions(scheduledSessions);
  Temporal.PlainDate.from(noticeEndsOn);
  return prorated(
    paidPeriodCents,
    sessions.filter((session) => session > noticeEndsOn).length,
    sessions.length,
  );
}

export function tierChangeAdjustment(
  oldMonthlyCents: number,
  newMonthlyCents: number,
  scheduledSessions: readonly string[],
  effectiveOn: string,
  mode: 'next_billing_date' | 'immediate',
): number {
  cents(oldMonthlyCents);
  cents(newMonthlyCents);
  const sessions = validateSessions(scheduledSessions);
  Temporal.PlainDate.from(effectiveOn);
  if (mode === 'next_billing_date') return 0;
  const remaining = sessions.filter((session) => session >= effectiveOn).length;
  const difference = newMonthlyCents - oldMonthlyCents;
  return difference < 0
    ? -prorated(-difference, remaining, sessions.length)
    : prorated(difference, remaining, sessions.length);
}

export function tuitionDuringPause(
  monthlyCents: number,
  scheduledSessions: readonly string[],
  pauseStartsOn: string,
  pauseEndsOn: string,
): number {
  const sessions = validateSessions(scheduledSessions);
  Temporal.PlainDate.from(pauseStartsOn);
  Temporal.PlainDate.from(pauseEndsOn);
  if (pauseStartsOn > pauseEndsOn)
    throw new RangeError('Pause end precedes start');
  return prorated(
    monthlyCents,
    sessions.filter(
      (session) => session < pauseStartsOn || session > pauseEndsOn,
    ).length,
    sessions.length,
  );
}
