import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import {
  ageOnDate,
  orgLocalToInstant,
  orgToday,
  startOfOrgDay,
  toOrgDate,
} from './dates';

describe('organization calendar math', () => {
  it('uses the org zone for date boundaries', () => {
    expect(toOrgDate('2026-01-01T02:00:00Z', 'America/Chicago')).toBe(
      '2025-12-31',
    );
    expect(
      orgToday(
        'America/Chicago',
        Temporal.Instant.from('2026-01-01T02:00:00Z'),
      ),
    ).toBe('2025-12-31');
  });

  it('handles spring daylight-saving changes without assuming 24-hour days', () => {
    expect(startOfOrgDay('2026-03-08', 'America/Chicago')).toBe(
      '2026-03-08T06:00:00Z',
    );
    expect(startOfOrgDay('2026-03-09', 'America/Chicago')).toBe(
      '2026-03-09T05:00:00Z',
    );
    expect(orgLocalToInstant('2026-03-08T03:30', 'America/Chicago')).toBe(
      '2026-03-08T08:30:00Z',
    );
    expect(() =>
      orgLocalToInstant('2026-03-08T02:30', 'America/Chicago'),
    ).toThrow(RangeError);
    expect(() =>
      orgLocalToInstant('2026-11-01T01:30', 'America/Chicago'),
    ).toThrow(RangeError);
  });

  it('keeps a leap-day child under 13 until March 1 in a nonleap year', () => {
    expect(ageOnDate('2012-02-29', '2025-02-28')).toBe(12);
    expect(ageOnDate('2012-02-29', '2025-03-01')).toBe(13);
    expect(() => ageOnDate('2026-01-01', '2025-12-31')).toThrow(RangeError);
  });
});
