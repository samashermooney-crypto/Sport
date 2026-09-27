import { describe, expect, it } from 'vitest';

import { formatCalendarFeed } from './events';

describe('schedule calendar feed encoding', () => {
  it('emits stable event ids, updates, cancellation state, and folded UTF-8 lines', () => {
    const feed = formatCalendarFeed([
      {
        id: 'game-1',
        title: `${'🏟️'.repeat(30)}, Field; Finals\\Updated`,
        starts_at: new Date('2026-10-04T15:00:00.000Z'),
        ends_at: new Date('2026-10-04T16:00:00.000Z'),
        timezone: 'America/Chicago',
        location_text: 'North Park\nField 2',
        status: 'canceled',
        version: 4,
      },
    ]);
    expect(feed).toContain('UID:game-1@athlentry');
    expect(feed).toContain('SEQUENCE:4');
    expect(feed).toContain('STATUS:CANCELLED');
    expect(feed).toContain('LOCATION:North Park\\nField 2');
    const unfolded = feed.replaceAll('\r\n ', '');
    expect(unfolded).toContain('SUMMARY:');
    expect(unfolded).toContain('\\, Field\\; Finals\\\\Updated');
    expect(feed.endsWith('\r\n')).toBe(true);
    for (const line of feed.split('\r\n').filter(Boolean))
      expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
  });
});
