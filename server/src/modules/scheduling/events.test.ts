import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';

import { formatCalendarFeed } from './events';
import { eventUpdateSchema } from './schema';

describe('schedule event update schema', () => {
  it('does not apply create defaults to omitted update fields', () => {
    const update = eventUpdateSchema.parse({ expectedVersion: 1 });

    expect(update).not.toHaveProperty('published');
    expect(update).not.toHaveProperty('participants');
    expect(update).not.toHaveProperty('arrivalMinutesBefore');
  });

  it('preserves explicitly provided publish and participant changes', () => {
    const update = eventUpdateSchema.parse({
      expectedVersion: 2,
      published: false,
      participants: [],
      arrivalMinutesBefore: 30,
    });

    expect(update.published).toBe(false);
    expect(update.participants).toEqual([]);
    expect(update.arrivalMinutesBefore).toBe(30);
  });
});

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

  it('parses with an iCalendar parser and keeps the moved game time', () => {
    const feed = formatCalendarFeed([
      {
        id: 'game-moved',
        title: 'Rescheduled game',
        starts_at: new Date('2026-10-10T17:00:00.000Z'),
        ends_at: new Date('2026-10-10T18:00:00.000Z'),
        timezone: 'America/Chicago',
        location_text: 'North Park',
        status: 'scheduled',
        version: 2,
      },
    ]);
    const parsed: unknown = ICAL.parse(feed);
    if (!Array.isArray(parsed))
      throw new Error('The feed did not parse to a jCal document.');
    const calendar = new ICAL.Component(parsed);
    expect(calendar.name).toBe('vcalendar');
    const vevents = calendar.getAllSubcomponents('vevent');
    expect(vevents).toHaveLength(1);
    const vevent = vevents[0];
    if (!vevent) throw new Error('VEVENT missing from the parsed feed.');
    expect(vevent.getFirstPropertyValue('uid')).toBe('game-moved@athlentry');
    const start = vevent.getFirstPropertyValue('dtstart') as ICAL.Time;
    expect(start.toJSDate().toISOString()).toBe('2026-10-10T17:00:00.000Z');
    expect(vevent.getFirstPropertyValue('sequence')).toBe(2);
  });
});
