import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

const localDate = z.iso.date();
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
const ianaZone = z
  .string()
  .min(1)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'Expected an IANA timezone');
const weekday = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
const dateArray = z.array(localDate).default([]);

export const recurrenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), date: localDate }),
  z.object({
    kind: z.literal('weekly'),
    interval: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    byDay: z.array(weekday).min(1),
    startsOn: localDate,
    endsOn: localDate.nullable(),
    count: z.number().int().positive().optional(),
    exceptions: dateArray,
    additions: dateArray,
  }),
  z.object({
    kind: z.literal('monthly_nth_weekday'),
    nth: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(-1),
    ]),
    weekday,
    startsOn: localDate,
    endsOn: localDate.nullable(),
    exceptions: dateArray,
  }),
]);
export const timedRecurrenceSchema = z.object({
  recurrence: recurrenceSchema,
  startTime: localTime,
  durationMinutes: z.number().int().positive(),
  timezone: ianaZone,
});

export type Weekday = z.infer<typeof weekday>;
export type Recurrence = z.input<typeof recurrenceSchema>;
export type TimedRecurrence = z.input<typeof timedRecurrenceSchema>;
export type Occurrence = {
  startsAt: string;
  endsAt: string;
  localDate: string;
};

const weekdays: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function plainDate(value: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(value);
}
function compareDate(a: Temporal.PlainDate, b: Temporal.PlainDate): number {
  return Temporal.PlainDate.compare(a, b);
}
function mondayOf(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.subtract({ days: date.dayOfWeek - 1 });
}
function dayCode(date: Temporal.PlainDate): Weekday {
  return weekdays[date.dayOfWeek - 1] ?? 'MO';
}

function nthWeekday(
  year: number,
  month: number,
  nth: 1 | 2 | 3 | 4 | -1,
  code: Weekday,
): Temporal.PlainDate {
  const wanted = weekdays.indexOf(code) + 1;
  if (nth === -1) {
    const last = Temporal.PlainDate.from({ year, month, day: 1 })
      .add({ months: 1 })
      .subtract({ days: 1 });
    return last.subtract({ days: (last.dayOfWeek - wanted + 7) % 7 });
  }
  const first = Temporal.PlainDate.from({ year, month, day: 1 });
  return first.add({
    days: ((wanted - first.dayOfWeek + 7) % 7) + (nth - 1) * 7,
  });
}

function localInstant(
  date: Temporal.PlainDate,
  time: string,
  timezone: string,
): Temporal.Instant {
  // `compatible` moves a gap time forward by its gap and chooses the earlier overlap instant.
  return date
    .toPlainDateTime(Temporal.PlainTime.from(time))
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant();
}

function occurrence(
  date: Temporal.PlainDate,
  time: string,
  minutes: number,
  timezone: string,
): Occurrence {
  const starts = localInstant(date, time, timezone);
  return {
    startsAt: starts.toString(),
    endsAt: starts.add({ minutes }).toString(),
    localDate: date.toString(),
  };
}

function assertRange(start: Temporal.PlainDate, end: Temporal.PlainDate): void {
  if (compareDate(start, end) > 0)
    throw new RangeError('rangeStart must be on or before rangeEnd');
}

export function expand(
  input: TimedRecurrence,
  rangeStart: string,
  rangeEnd: string,
): Occurrence[] {
  const timed = timedRecurrenceSchema.parse(input);
  const from = plainDate(rangeStart);
  const to = plainDate(rangeEnd);
  assertRange(from, to);
  const rule = timed.recurrence;
  const dates: Temporal.PlainDate[] = [];
  if (rule.kind === 'once') {
    const date = plainDate(rule.date);
    if (compareDate(date, from) >= 0 && compareDate(date, to) <= 0)
      dates.push(date);
  } else if (rule.kind === 'weekly') {
    const starts = plainDate(rule.startsOn);
    const ends = rule.endsOn ? plainDate(rule.endsOn) : to;
    if (compareDate(starts, ends) > 0)
      throw new RangeError('Recurrence end precedes start');
    const blocked = new Set(rule.exceptions);
    const byDay = new Set<Weekday>(rule.byDay);
    const anchor = mondayOf(starts);
    let generated = 0;
    // Count applies to scheduled base dates, before exceptions and additions.
    for (
      let date = starts;
      compareDate(date, ends) <= 0 && compareDate(date, to) <= 0;
      date = date.add({ days: 1 })
    ) {
      const weeks = Math.floor(
        anchor.until(mondayOf(date), { largestUnit: 'weeks' }).weeks,
      );
      if (weeks % rule.interval !== 0 || !byDay.has(dayCode(date))) continue;
      generated += 1;
      if (rule.count !== undefined && generated > rule.count) break;
      if (compareDate(date, from) >= 0 && !blocked.has(date.toString()))
        dates.push(date);
    }
    for (const addition of rule.additions) {
      const date = plainDate(addition);
      if (compareDate(date, from) >= 0 && compareDate(date, to) <= 0)
        dates.push(date);
    }
  } else {
    const starts = plainDate(rule.startsOn);
    const ends = rule.endsOn ? plainDate(rule.endsOn) : to;
    if (compareDate(starts, ends) > 0)
      throw new RangeError('Recurrence end precedes start');
    const blocked = new Set(rule.exceptions);
    const firstMonth = Temporal.PlainYearMonth.from({
      year: starts.year,
      month: starts.month,
    });
    for (
      let month = firstMonth;
      Temporal.PlainYearMonth.compare(
        month,
        Temporal.PlainYearMonth.from({ year: to.year, month: to.month }),
      ) <= 0;
      month = month.add({ months: 1 })
    ) {
      const date = nthWeekday(month.year, month.month, rule.nth, rule.weekday);
      if (
        compareDate(date, starts) >= 0 &&
        compareDate(date, ends) <= 0 &&
        compareDate(date, from) >= 0 &&
        compareDate(date, to) <= 0 &&
        !blocked.has(date.toString())
      )
        dates.push(date);
    }
  }
  return [...new Set(dates.map((date) => date.toString()))]
    .sort()
    .map((date) =>
      occurrence(
        plainDate(date),
        timed.startTime,
        timed.durationMinutes,
        timed.timezone,
      ),
    );
}

function icsDateTime(date: string, time: string): string {
  return `${date.replaceAll('-', '')}T${time.replaceAll(':', '').padEnd(6, '0')}`;
}

export function toRfc5545(input: TimedRecurrence): string {
  const timed = timedRecurrenceSchema.parse(input);
  const rule = timed.recurrence;
  const first = rule.kind === 'once' ? rule.date : rule.startsOn;
  const lines = [
    `DTSTART;TZID=${timed.timezone}:${icsDateTime(first, timed.startTime)}`,
    `DURATION:PT${String(timed.durationMinutes)}M`,
  ];
  if (rule.kind === 'weekly') {
    const parts = [
      `FREQ=WEEKLY`,
      `INTERVAL=${String(rule.interval)}`,
      `BYDAY=${rule.byDay.join(',')}`,
    ];
    if (rule.count !== undefined) parts.push(`COUNT=${String(rule.count)}`);
    else if (rule.endsOn)
      parts.push(
        `UNTIL=${localInstant(
          plainDate(rule.endsOn),
          timed.startTime,
          timed.timezone,
        )
          .toString()
          .replaceAll(/[-:]/g, '')
          .replace(/\.\d+Z$/, 'Z')}`,
      );
    lines.push(`RRULE:${parts.join(';')}`);
    if (rule.exceptions.length)
      lines.push(
        `EXDATE;TZID=${timed.timezone}:${rule.exceptions.map((date) => icsDateTime(date, timed.startTime)).join(',')}`,
      );
    if (rule.additions.length)
      lines.push(
        `RDATE;TZID=${timed.timezone}:${rule.additions.map((date) => icsDateTime(date, timed.startTime)).join(',')}`,
      );
  } else if (rule.kind === 'monthly_nth_weekday') {
    const parts = [`FREQ=MONTHLY`, `BYDAY=${String(rule.nth)}${rule.weekday}`];
    if (rule.endsOn)
      parts.push(
        `UNTIL=${localInstant(
          plainDate(rule.endsOn),
          timed.startTime,
          timed.timezone,
        )
          .toString()
          .replaceAll(/[-:]/g, '')
          .replace(/\.\d+Z$/, 'Z')}`,
      );
    lines.push(`RRULE:${parts.join(';')}`);
    if (rule.exceptions.length)
      lines.push(
        `EXDATE;TZID=${timed.timezone}:${rule.exceptions.map((date) => icsDateTime(date, timed.startTime)).join(',')}`,
      );
  }
  return lines.join('\r\n');
}
