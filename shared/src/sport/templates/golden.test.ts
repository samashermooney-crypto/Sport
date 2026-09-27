import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { sportProfileSchema } from '../schema.js';

import { builtInSportTemplates } from './index.js';

describe('built-in sport templates', () => {
  it('contains every published template exactly once', () => {
    expect(builtInSportTemplates).toHaveLength(46);
    expect(
      new Set(builtInSportTemplates.map((profile) => profile.key)).size,
    ).toBe(46);
  });

  it.each(builtInSportTemplates)(
    '$key matches its reviewed golden file',
    (profile) => {
      expect(sportProfileSchema.safeParse(profile).success).toBe(true);
      const golden = readFileSync(
        new URL(`./__golden__/${profile.key}.json`, import.meta.url),
        'utf8',
      );
      expect(`${JSON.stringify(profile, null, 2)}\n`).toBe(golden);
    },
  );
});
