import { describe, expect, it } from 'vitest';

import { nextReportScheduleAt, reportScheduleAnchor } from './schedule-time';

describe('report schedule timezone recurrence', () => {
  it('keeps the selected local time through the daylight-saving transition', () => {
    const next = nextReportScheduleAt({
      cadence: 'daily',
      runAtMinute: 8 * 60,
      runOnDay: null,
      runOnWeekday: null,
      timezone: 'America/Chicago',
      after: new Date('2026-03-07T15:00:00.000Z'),
    });

    expect(next.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('anchors weekly cadence to the schedule creation weekday', () => {
    const now = new Date('2026-09-27T15:00:00.000Z');
    const anchor = reportScheduleAnchor('weekly', now, 'America/Chicago');
    const next = nextReportScheduleAt({
      cadence: 'weekly',
      runAtMinute: 9 * 60,
      runOnDay: anchor.runOnDay,
      runOnWeekday: anchor.runOnWeekday,
      timezone: 'America/Chicago',
      after: now,
    });

    expect(anchor.runOnWeekday).toBe(7);
    expect(next.toISOString()).toBe('2026-10-04T14:00:00.000Z');
  });

  it('runs monthly on the last day when the anchor day is absent', () => {
    const next = nextReportScheduleAt({
      cadence: 'monthly',
      runAtMinute: 8 * 60,
      runOnDay: 31,
      runOnWeekday: null,
      timezone: 'America/Chicago',
      after: new Date('2027-02-27T12:00:00.000Z'),
    });

    expect(next.toISOString()).toBe('2027-02-28T14:00:00.000Z');
  });
});
