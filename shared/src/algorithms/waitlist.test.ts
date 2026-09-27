import { describe, expect, it } from 'vitest';

import { nextWaitlistOffer, type WaitlistEntry } from './waitlist.js';

const entries: WaitlistEntry[] = [
  {
    id: 'first',
    offeringId: 'o1',
    programId: 'p',
    personId: 'a',
    joinedAt: '2026-09-01T10:00:00Z',
    position: 1,
    status: 'waiting',
    timezone: 'America/Chicago',
  },
  {
    id: 'second',
    offeringId: 'o1',
    programId: 'p',
    personId: 'b',
    joinedAt: '2026-09-01T11:00:00Z',
    position: 2,
    status: 'waiting',
    timezone: 'America/Chicago',
  },
];

describe('waitlist advance', () => {
  it('offers the first waiting entry with a hold and starts expiry at send time', () => {
    expect(
      nextWaitlistOffer({
        entries,
        offeringId: 'o1',
        capacity: 2,
        confirmed: 1,
        held: 0,
        mode: 'auto',
        now: '2026-09-02T03:00:00Z',
      }),
    ).toEqual({
      entryId: 'first',
      sendAt: '2026-09-02T13:00:00Z',
      expiresAt: '2026-09-04T13:00:00Z',
      holdCount: 1,
    });
  });

  it('prevents more than one active offer for a participant in a program', () => {
    const first = entries[0];
    if (!first) throw new Error('Test entry missing');
    const active: WaitlistEntry = {
      ...first,
      id: 'old',
      offeringId: 'o2',
      status: 'offered',
    };
    expect(
      nextWaitlistOffer({
        entries: [...entries, active],
        offeringId: 'o1',
        capacity: 2,
        confirmed: 1,
        held: 0,
        mode: 'auto',
        now: '2026-09-02T15:00:00Z',
      })?.entryId,
    ).toBe('second');
  });

  it('requires staff selection in manual mode and refuses full capacity', () => {
    expect(
      nextWaitlistOffer({
        entries,
        offeringId: 'o1',
        capacity: 2,
        confirmed: 1,
        held: 0,
        mode: 'manual',
        now: '2026-09-02T15:00:00Z',
      }),
    ).toBeNull();
    expect(
      nextWaitlistOffer({
        entries,
        offeringId: 'o1',
        capacity: 2,
        confirmed: 1,
        held: 0,
        mode: 'manual',
        manualEntryId: 'second',
        now: '2026-09-02T15:00:00Z',
      })?.entryId,
    ).toBe('second');
    expect(
      nextWaitlistOffer({
        entries,
        offeringId: 'o1',
        capacity: 1,
        confirmed: 1,
        held: 0,
        mode: 'auto',
        now: '2026-09-02T15:00:00Z',
      }),
    ).toBeNull();
  });
});
