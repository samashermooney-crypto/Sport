import { describe, expect, it } from 'vitest';

import { createOrgSchema, orgSlugSchema } from './orgs';

const valid = {
  name: 'Northside Youth Soccer',
  slug: 'northside-soccer',
  kind: 'club',
  timezone: 'America/Chicago',
  address: {
    line1: '100 Main St',
    city: 'Chicago',
    region: 'IL',
    postalCode: '60601',
    country: 'US',
  },
  sportKeys: ['soccer'],
};

describe('organization onboarding input', () => {
  it('accepts a US organization with multiple distinct sports', () => {
    expect(
      createOrgSchema.parse({ ...valid, sportKeys: ['soccer', 'futsal'] }),
    ).toMatchObject({ slug: 'northside-soccer', kind: 'club' });
  });

  it('rejects reserved and malformed public slugs', () => {
    for (const slug of [
      'api',
      'platform',
      'sign-up',
      'Bad-Slug',
      'bad--slug',
    ]) {
      expect(orgSlugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });

  it('rejects ambiguous setup data before tenant creation', () => {
    expect(
      createOrgSchema.safeParse({ ...valid, sportKeys: ['soccer', 'soccer'] })
        .success,
    ).toBe(false);
    expect(
      createOrgSchema.safeParse({ ...valid, timezone: 'Not/A_Zone' }).success,
    ).toBe(false);
    expect(
      createOrgSchema.safeParse({
        ...valid,
        address: { ...valid.address, country: 'CA' },
      }).success,
    ).toBe(false);
  });
});
