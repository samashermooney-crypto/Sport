import { describe, expect, it, vi } from 'vitest';

import {
  WaitlistOfferService,
  offerWindow,
  type WaitlistOfferRepository,
} from './waitlist.js';

describe('waitlist offer holds', () => {
  it('starts the expiry clock when a quiet-hours offer is sent', () => {
    expect(offerWindow('2026-09-27T03:00:00Z', 'America/Chicago', 48)).toEqual({
      sendAt: '2026-09-27T13:00:00Z',
      expiresAt: '2026-09-29T13:00:00Z',
    });
    expect(() =>
      offerWindow('2026-09-27T03:00:00Z', 'America/Chicago', 3),
    ).toThrow();
  });

  it('passes an atomic offer request to the repository and accepts the reserved seat', async () => {
    const offerNext = vi
      .fn<WaitlistOfferRepository['offerNext']>()
      .mockResolvedValue({
        entryId: 'entry_1',
        personId: 'person_1',
        offeringId: 'offering_1',
        sendAt: '2026-09-27T13:00:00Z',
        expiresAt: '2026-09-29T13:00:00Z',
      });
    const accept = vi
      .fn<WaitlistOfferRepository['accept']>()
      .mockResolvedValue('accepted');
    const service = new WaitlistOfferService({
      offerNext,
      accept,
      declineOrExpire: vi.fn().mockResolvedValue(true),
    });
    const offer = await service.offerNext({
      orgId: 'org_1',
      offeringId: 'offering_1',
      now: '2026-09-27T03:00:00Z',
      familyTimezone: 'America/Chicago',
      idempotencyKey: 'offer_1',
    });
    expect(offer).toMatchObject({ entryId: 'entry_1' });
    expect(offerNext.mock.calls[0]?.[0]).toMatchObject({
      sendAt: '2026-09-27T13:00:00Z',
      expiresAt: '2026-09-29T13:00:00Z',
    });
    expect(
      await service.accept({
        orgId: 'org_1',
        entryId: 'entry_1',
        checkoutId: 'checkout_1',
        at: '2026-09-28T13:00:00Z',
      }),
    ).toBe('accepted');
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
