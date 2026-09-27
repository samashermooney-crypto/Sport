import { randomUUID } from 'node:crypto';

import { createOrgSchema } from '@shared/schemas/orgs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';

import { isOrgSlugAvailable } from './slug';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

describe('organization onboarding input', () => {
  it('requires a real timezone, address and primary sport', () => {
    const valid = {
      name: 'River Club',
      slug: 'river-club',
      kind: 'club',
      timezone: 'America/Chicago',
      address: {
        line1: '1 Main St',
        city: 'Chicago',
        region: 'IL',
        postalCode: '60601',
        country: 'US',
      },
      sportKeys: ['soccer'],
    };
    expect(createOrgSchema.safeParse(valid).success).toBe(true);
    expect(
      createOrgSchema.safeParse({ ...valid, timezone: 'Mars/Base' }).success,
    ).toBe(false);
    expect(createOrgSchema.safeParse({ ...valid, sportKeys: [] }).success).toBe(
      false,
    );
    expect(
      createOrgSchema.safeParse({ ...valid, slug: 'Not Safe' }).success,
    ).toBe(false);
  });

  it('rejects reserved and existing slugs and accepts a free one', async () => {
    const slug = `river-${randomUUID().slice(0, 8)}`;
    expect(await isOrgSlugAvailable(database, 'platform')).toBe(false);
    expect(await isOrgSlugAvailable(database, slug)).toBe(true);
    await database
      .insertInto('organizations')
      .values({
        id: randomUUID(),
        slug,
        name: 'River Club',
        kind: 'club',
        timezone: 'America/Chicago',
      })
      .execute();
    expect(await isOrgSlugAvailable(database, slug)).toBe(false);
  });
});
