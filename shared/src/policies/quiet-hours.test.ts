import { describe, expect, it } from 'vitest';

import { quietHoursDecision } from './quiet-hours.js';

describe('quiet hours', () => {
  it('holds SMS and push from 21:00 to 08:00 recipient local time', () => {
    expect(
      quietHoursDecision(
        '2026-09-02T03:00:00Z',
        'America/Chicago',
        'sms',
        false,
      ),
    ).toEqual({ sendNow: false, nextSendAt: '2026-09-02T13:00:00Z' });
    expect(
      quietHoursDecision(
        '2026-09-02T14:00:00Z',
        'America/Chicago',
        'push',
        false,
      ).sendNow,
    ).toBe(true);
  });

  it('delivers emergency messages and email immediately', () => {
    expect(
      quietHoursDecision('2026-09-02T03:00:00Z', 'America/Chicago', 'sms', true)
        .sendNow,
    ).toBe(true);
    expect(
      quietHoursDecision(
        '2026-09-02T03:00:00Z',
        'America/Chicago',
        'email',
        false,
      ).sendNow,
    ).toBe(true);
  });
});
