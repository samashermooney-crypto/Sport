import { describe, expect, it } from 'vitest';

import { sportProfileSchema } from './schema.js';

const text = { en: 'General', es: 'General' };
const profile = {
  key: 'sample',
  name: text,
  category: 'team',
  participantTerms: {
    athlete: text,
    athletes: text,
    team: text,
    coach: text,
    contest: text,
    practice: text,
    venue: text,
  },
  contestFormats: [
    {
      format: 'head_to_head_score',
      periods: { label: text, count: 2 },
      scoreLabel: text,
      allowTie: true,
      scoreDirection: 'higher_wins',
    },
  ],
  positions: [],
  maxPositionsPerAthlete: 0,
  roster: { defaultMax: 18, defaultMin: 1, jerseyNumbers: 'optional' },
  stats: [],
  ageGroup: {
    method: 'age_on_date',
    monthDay: '08-01',
    yearBasis: 'season_end',
  },
  defaultDurations: {
    contestMinutes: 60,
    practiceMinutes: 60,
    bufferMinutes: 15,
  },
  spaceKinds: ['field'],
  officials: [],
  evaluationRubric: [],
  uniformItems: [],
  disciplineTypes: [],
};

describe('sport profile schema', () => {
  it('accepts the complete required profile shape', () => {
    expect(sportProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('rejects invalid age cutoffs, roster bounds and duplicate keys', () => {
    expect(
      sportProfileSchema.safeParse({
        ...profile,
        ageGroup: {
          method: 'age_on_date',
          monthDay: '13-01',
          yearBasis: 'season_end',
        },
      }).success,
    ).toBe(false);
    expect(
      sportProfileSchema.safeParse({
        ...profile,
        roster: { ...profile.roster, defaultMin: 19 },
      }).success,
    ).toBe(false);
    expect(
      sportProfileSchema.safeParse({
        ...profile,
        positions: [
          { key: 'gk', label: text },
          { key: 'gk', label: text },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects missing translations and unknown contest formats', () => {
    expect(
      sportProfileSchema.safeParse({ ...profile, name: { en: 'General' } })
        .success,
    ).toBe(false);
    expect(
      sportProfileSchema.safeParse({
        ...profile,
        contestFormats: [{ format: 'invented' }],
      }).success,
    ).toBe(false);
  });
});
