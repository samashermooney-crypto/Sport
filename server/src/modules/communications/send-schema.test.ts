import { describe, expect, it } from 'vitest';

import { sendConcurrency } from './delivery';
import { campaignStatsSchema, sendCampaignSchema } from './schema';

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

describe('campaignStatsSchema', () => {
  it('reports only the channels a campaign uses', () => {
    const stats = {
      id: '01a0f3a5-3522-7075-a935-8e88a949dcb0',
      status: 'sent',
      counts: { email: { sent: 20_000, failed: 0 } },
    };
    expect(campaignStatsSchema.parse(stats)).toEqual(stats);
    expect(
      campaignStatsSchema.safeParse({ ...stats, counts: { fax: {} } }).success,
    ).toBe(false);
  });
});

describe('sendConcurrency', () => {
  it('defaults to four parallel sends and bounds overrides', () => {
    expect(sendConcurrency(undefined)).toBe(4);
    expect(sendConcurrency('12')).toBe(12);
    for (const value of ['0', '33', '1.5'])
      expect(() => sendConcurrency(value)).toThrow(
        'COMMUNICATIONS_SEND_CONCURRENCY must be an integer from 1 to 32',
      );
  });
});
