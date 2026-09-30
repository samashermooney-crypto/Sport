import { describe, expect, it } from 'vitest';

import { validateDemoTimezones } from '../../db/seeds/demo';

describe('demo organization time zones', () => {
  it('validates every checked-in demo profile', () => {
    expect(() => {
      validateDemoTimezones();
    }).not.toThrow();
  });

  it('reports an unsupported IANA zone with its organization slug', () => {
    expect(() => {
      validateDemoTimezones([
        { slug: 'northstar-gymnastics-swim', timezone: 'America/Minneapolis' },
      ]);
    }).toThrow(
      'Invalid IANA time zone "America/Minneapolis" for demo organization northstar-gymnastics-swim',
    );
  });
});
