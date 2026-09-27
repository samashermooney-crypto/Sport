import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { sportProfileSchema } from '../schema.js';

import { getTemplateSeed } from './catalog.js';

import { builtInSportTemplates } from './index.js';

describe('built-in sport templates', () => {
  it('contains every published template exactly once', () => {
    expect(builtInSportTemplates).toHaveLength(46);
    expect(
      new Set(builtInSportTemplates.map((profile) => profile.key)).size,
    ).toBe(46);
  });

  it('rejects unknown template seed keys', () => {
    expect(() => getTemplateSeed('invented-sport')).toThrow(
      'Unknown sport template: invented-sport',
    );
  });

  it.each(builtInSportTemplates)(
    '$key matches its reviewed golden file',
    (profile) => {
      expect(sportProfileSchema.safeParse(profile).success).toBe(true);
      const golden: unknown = JSON.parse(
        readFileSync(
          new URL(`./__golden__/${profile.key}.json`, import.meta.url),
          'utf8',
        ),
      );
      expect(profile).toEqual(golden);
    },
  );
});
