import { describe, expect, it } from 'vitest';

import { checkSafeSport, type SafeSportInput } from './safesport.js';

const coach = {
  accountId: 'coach',
  age: 35,
  adultRole: 'coach' as const,
  guardianOf: [],
};
const minor = {
  accountId: 'athlete',
  age: 16,
  adultRole: null,
  guardianOf: [],
};
const guardian = {
  accountId: 'guardian',
  age: 40,
  adultRole: null,
  guardianOf: ['athlete'],
};
const base: SafeSportInput = {
  kind: 'message',
  senderAccountId: 'coach',
  members: [coach, minor],
  guardianLinks: { athlete: ['guardian'] },
  smsRecipientIds: ['athlete', 'guardian'],
};

describe('SafeSport messaging', () => {
  it('auto-adds guardians for adult staff messages and blocks SMS to minors', () => {
    expect(checkSafeSport(base)).toEqual({
      allowed: true,
      code: null,
      guardianAdditions: ['guardian'],
      guardianCopied: true,
      blockedSmsRecipientIds: ['athlete'],
    });
  });

  it('rejects direct conversations without an existing guardian member', () => {
    expect(checkSafeSport({ ...base, kind: 'direct' })).toMatchObject({
      allowed: false,
      code: 'SAFESPORT_GUARDIAN_REQUIRED',
    });
    expect(
      checkSafeSport({
        ...base,
        kind: 'direct',
        members: [coach, minor, guardian],
      }).allowed,
    ).toBe(true);
  });

  it('adds all guardians to team conversations', () => {
    expect(
      checkSafeSport({
        ...base,
        kind: 'team',
        guardianLinks: { athlete: ['guardian', 'other'] },
      }).guardianAdditions,
    ).toEqual(['guardian', 'other']);
  });

  it('fails closed when the minor has no guardian link', () => {
    expect(checkSafeSport({ ...base, guardianLinks: {} }).code).toBe(
      'SAFESPORT_GUARDIAN_REQUIRED',
    );
  });

  it('does not require a second guardian for the athlete’s own guardian', () => {
    expect(
      checkSafeSport({
        ...base,
        senderAccountId: 'guardian',
        members: [guardian, minor],
      }).guardianAdditions,
    ).toEqual([]);
  });

  it('rejects duplicate members and a missing sender', () => {
    expect(() =>
      checkSafeSport({ ...base, members: [coach, coach, minor] }),
    ).toThrow();
    expect(() =>
      checkSafeSport({ ...base, senderAccountId: 'absent' }),
    ).toThrow();
  });
});
