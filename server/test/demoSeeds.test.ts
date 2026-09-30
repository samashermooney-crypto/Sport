import { createOrgSchema } from '@shared/schemas/orgs';
import { describe, expect, it } from 'vitest';

import {
  demoOrganizationAddress,
  validateDemoTimezones,
} from '../../db/seeds/demo';

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

describe('demo organization profile fixtures', () => {
  it('builds domestic addresses accepted by the organization profile contract', () => {
    const address = demoOrganizationAddress({
      line1: '100 Demo Way',
      city: 'Naperville',
      region: 'IL',
      postalCode: '00000',
    });

    expect(createOrgSchema.shape.address.parse(address)).toEqual({
      line1: '100 Demo Way',
      city: 'Naperville',
      region: 'IL',
      postalCode: '00000',
      country: 'US',
    });
  });
});
