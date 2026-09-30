import { describe, expect, it } from 'vitest';

import { sendCampaignSchema } from './schema';

describe('sendCampaignSchema', () => {
  it('accepts the preview counts of a single-channel campaign', () => {
    // The console posts the preview's counts, which only list used channels.
    expect(
      sendCampaignSchema.parse({
        expectedVersion: 3,
        confirmRecipientCounts: { email: 20_000 },
      }),
    ).toEqual({
      expectedVersion: 3,
      confirmRecipientCounts: { email: 20_000 },
    });
  });

  it('rejects unknown channels, negative counts and extra fields', () => {
    for (const body of [
      { expectedVersion: 1, confirmRecipientCounts: { fax: 1 } },
      { expectedVersion: 1, confirmRecipientCounts: { sms: -1 } },
      { expectedVersion: 1, confirmRecipientCounts: {}, force: true },
      { expectedVersion: 0 },
    ])
      expect(sendCampaignSchema.safeParse(body).success).toBe(false);
  });
});
