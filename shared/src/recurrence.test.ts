import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  expand,
  timedRecurrenceSchema,
  toRfc5545,
  type TimedRecurrence,
} from './recurrence.js';

const weekly: TimedRecurrence = {
  recurrence: {
    kind: 'weekly',
    interval: 1,
    byDay: ['MO', 'WE'],
    startsOn: '2026-09-01',
    endsOn: '2026-09-30',
    exceptions: ['2026-09-07'],
    additions: ['2026-09-08'],
  },
  startTime: '16:30',
  durationMinutes: 90,
  timezone: 'America/Chicago',
};

describe('recurrence expansion', () => {
  it('includes additions and excludes exceptions, with unique sorted dates', () => {
    const dates = expand(weekly, '2026-09-01', '2026-09-15').map(
      (entry) => entry.localDate,
    );
    expect(dates).toEqual([
      '2026-09-02',
      '2026-09-08',
      '2026-09-09',
      '2026-09-14',
    ]);
  });

  it('counts base occurrences before applying exceptions', () => {
    const recurrence: TimedRecurrence = {
      ...weekly,
      recurrence: {
        kind: 'weekly',
        interval: 1,
        byDay: ['MO'],
        startsOn: '2026-09-01',
        endsOn: null,
        count: 2,
        exceptions: ['2026-09-07'],
        additions: ['2026-09-22'],
      },
    };
    expect(
      expand(recurrence, '2026-09-01', '2026-09-30').map(
        (entry) => entry.localDate,
      ),
    ).toEqual(['2026-09-14', '2026-09-22']);
  });

  it('uses the selected nth weekday, including last weekday', () => {
    const timed: TimedRecurrence = {
      recurrence: {
        kind: 'monthly_nth_weekday',
        nth: -1,
        weekday: 'FR',
        startsOn: '2026-01-01',
        endsOn: '2026-04-30',
        exceptions: ['2026-02-27'],
      },
      startTime: '09:00',
      durationMinutes: 60,
      timezone: 'America/Phoenix',
    };
    expect(
      expand(timed, '2026-01-01', '2026-04-30').map((entry) => entry.localDate),
    ).toEqual(['2026-01-30', '2026-03-27', '2026-04-24']);
  });

  it.each([
    'America/Chicago',
    'America/New_York',
    'America/Phoenix',
    'Pacific/Honolulu',
  ])('preserves local wall time across DST in %s', (timezone) => {
    const timed: TimedRecurrence = {
      recurrence: {
        kind: 'weekly',
        interval: 1,
        byDay: ['SU'],
        startsOn: '2026-03-01',
        endsOn: '2026-03-22',
        exceptions: [],
        additions: [],
      },
      startTime: '02:30',
      durationMinutes: 60,
      timezone,
    };
    const occurrences = expand(timed, '2026-03-01', '2026-03-22');
    expect(occurrences).toHaveLength(4);
    expect(occurrences.map((entry) => entry.localDate)).toEqual([
      '2026-03-01',
      '2026-03-08',
      '2026-03-15',
      '2026-03-22',
    ]);
    expect(occurrences[1]?.startsAt).toBe(
      timezone === 'America/Chicago'
        ? '2026-03-08T08:30:00Z'
        : timezone === 'America/New_York'
          ? '2026-03-08T07:30:00Z'
          : timezone === 'America/Phoenix'
            ? '2026-03-08T09:30:00Z'
            : '2026-03-08T12:30:00Z',
    );
  });

  it('chooses the earlier instant for a fall overlap', () => {
    const timed: TimedRecurrence = {
      recurrence: { kind: 'once', date: '2026-11-01' },
      startTime: '01:30',
      durationMinutes: 60,
      timezone: 'America/Chicago',
    };
    expect(expand(timed, '2026-11-01', '2026-11-01')[0]?.startsAt).toBe(
      '2026-11-01T06:30:00Z',
    );
  });

  it('rejects invalid zones and reversed ranges', () => {
    expect(
      timedRecurrenceSchema.safeParse({ ...weekly, timezone: 'Mars/Olympus' })
        .success,
    ).toBe(false);
    expect(() => expand(weekly, '2026-10-01', '2026-09-01')).toThrow();
  });

  it('emits RFC 5545 fields for ICS export', () => {
    const ics = toRfc5545(weekly);
    expect(ics).toContain('DTSTART;TZID=America/Chicago:20260901T163000');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE');
    expect(ics).toContain('EXDATE;TZID=America/Chicago:20260907T163000');
    expect(ics).toContain('RDATE;TZID=America/Chicago:20260908T163000');
  });

  it('always returns unique dates within the requested range', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 30 }),
        (interval, day) => {
          if (![1, 2, 3, 4].includes(interval)) return;
          const input: TimedRecurrence = {
            recurrence: {
              kind: 'weekly',
              interval: interval as 1 | 2 | 3 | 4,
              byDay: ['MO', 'WE', 'FR'],
              startsOn: '2026-09-01',
              endsOn: '2026-10-31',
              exceptions: [],
              additions: [`2026-09-${String(day).padStart(2, '0')}`],
            },
            startTime: '12:00',
            durationMinutes: 45,
            timezone: 'America/New_York',
          };
          const dates = expand(input, '2026-09-01', '2026-09-30').map(
            (entry) => entry.localDate,
          );
          expect(dates).toEqual([...new Set(dates)].sort());
          expect(
            dates.every((date) => date >= '2026-09-01' && date <= '2026-09-30'),
          ).toBe(true);
        },
      ),
    );
  });
});
