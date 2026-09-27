import { describe, expect, it } from 'vitest';

import {
  cardExpiryNoticeOn,
  firstInstallmentAttemptAt,
  nextInstallmentAttempt,
} from './dunning-schedule.js';

describe('dunning schedule', () => {
  it('starts at ten local and retries after 1, 3 and 7 days', () => {
    expect(firstInstallmentAttemptAt('2026-09-01', 'America/Chicago')).toBe(
      '2026-09-01T15:00:00Z',
    );
    expect(
      nextInstallmentAttempt(
        '2026-09-01T15:00:00Z',
        1,
        'do_not_honor',
        'America/Chicago',
      ).nextAttemptAt,
    ).toBe('2026-09-02T15:00:00Z');
    expect(
      nextInstallmentAttempt(
        '2026-09-02T15:00:00Z',
        2,
        'do_not_honor',
        'America/Chicago',
      ).nextAttemptAt,
    ).toBe('2026-09-05T15:00:00Z');
    expect(
      nextInstallmentAttempt(
        '2026-09-05T15:00:00Z',
        3,
        'do_not_honor',
        'America/Chicago',
      ).nextAttemptAt,
    ).toBe('2026-09-12T15:00:00Z');
    expect(
      nextInstallmentAttempt(
        '2026-09-12T15:00:00Z',
        4,
        'do_not_honor',
        'America/Chicago',
      ).finalFailure,
    ).toBe(true);
  });

  it('stops nonretryable errors and warns before card expiry', () => {
    expect(
      nextInstallmentAttempt(
        '2026-09-01T15:00:00Z',
        1,
        'expired_card',
        'America/Chicago',
      ),
    ).toMatchObject({ retry: false, requiresPaymentMethodUpdate: true });
    expect(cardExpiryNoticeOn('2026-09-15')).toBe('2026-09-01');
  });

  it('preserves 10:00 wall time across daylight saving changes', () => {
    expect(
      nextInstallmentAttempt(
        '2026-10-31T15:00:00Z',
        2,
        'do_not_honor',
        'America/Chicago',
      ).nextAttemptAt,
    ).toBe('2026-11-03T16:00:00Z');
  });

  it('rejects invalid attempt numbers', () => {
    expect(() =>
      nextInstallmentAttempt(
        '2026-09-01T15:00:00Z',
        0,
        'do_not_honor',
        'America/Chicago',
      ),
    ).toThrow();
  });
});
