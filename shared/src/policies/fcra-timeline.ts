import { Temporal } from '@js-temporal/polyfill';

export function earliestAdverseActionDate(
  preAdverseNoticeOn: string,
  holidays: readonly string[] = [],
): string {
  let date = Temporal.PlainDate.from(preAdverseNoticeOn);
  const holidaySet = new Set(holidays);
  let elapsed = 0;
  while (elapsed < 5) {
    date = date.add({ days: 1 });
    if (date.dayOfWeek < 6 && !holidaySet.has(date.toString())) elapsed += 1;
  }
  return date.toString();
}

export function canAdjudicateIneligible(
  preAdverseNoticeOn: string | null,
  todayLocal: string,
  holidays: readonly string[] = [],
): boolean {
  if (!preAdverseNoticeOn) return false;
  return (
    Temporal.PlainDate.compare(
      Temporal.PlainDate.from(todayLocal),
      Temporal.PlainDate.from(
        earliestAdverseActionDate(preAdverseNoticeOn, holidays),
      ),
    ) >= 0
  );
}
