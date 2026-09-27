import { Temporal } from '@js-temporal/polyfill';
import type { ReportScheduleBody } from '@shared/schemas/reports';

export interface ReportScheduleAnchor {
  runOnDay: number | null;
  runOnWeekday: number | null;
}

export function reportScheduleAnchor(
  cadence: ReportScheduleBody['cadence'],
  now: Date,
  timezone: string,
): ReportScheduleAnchor {
  const local = Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(
    timezone,
  );
  return {
    runOnDay: cadence === 'monthly' ? local.day : null,
    runOnWeekday: cadence === 'weekly' ? local.dayOfWeek : null,
  };
}

export function nextReportScheduleAt(input: {
  cadence: ReportScheduleBody['cadence'];
  runAtMinute: number;
  runOnDay: number | null;
  runOnWeekday: number | null;
  timezone: string;
  after: Date;
}): Date {
  const after = Temporal.Instant.from(input.after.toISOString());
  const localAfter = after.toZonedDateTimeISO(input.timezone);
  const startDate = localAfter.toPlainDate();
  const hour = Math.floor(input.runAtMinute / 60);
  const minute = input.runAtMinute % 60;

  for (let offset = 0; offset <= 366 * 3; offset += 1) {
    const date = startDate.add({ days: offset });
    if (input.cadence === 'weekly' && date.dayOfWeek !== input.runOnWeekday)
      continue;
    if (
      input.cadence === 'monthly' &&
      date.day !== Math.min(input.runOnDay ?? 1, date.daysInMonth)
    )
      continue;
    const candidate = Temporal.ZonedDateTime.from(
      {
        timeZone: input.timezone,
        year: date.year,
        month: date.month,
        day: date.day,
        hour,
        minute,
        second: 0,
        millisecond: 0,
      },
      { disambiguation: 'later' },
    ).toInstant();
    if (Temporal.Instant.compare(candidate, after) > 0)
      return new Date(candidate.epochMilliseconds);
  }
  throw new RangeError('Could not find the next report schedule occurrence');
}
