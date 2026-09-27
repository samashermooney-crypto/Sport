import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  rankTimed,
  scoreCrossCountryTeams,
  scoreGolfTeams,
} from './results.js';
import { sportProfileSchema, type StatDefinition } from './schema.js';
import { computeStandings, type StandingContest } from './standings.js';
import { aggregateStats } from './stats.js';
import { builtInSportTemplates } from './templates/index.js';

const points: StatDefinition = {
  key: 'points',
  label: { en: 'Points', es: 'Puntos' },
  abbreviation: 'PTS',
  level: 'athlete',
  valueType: 'integer',
  aggregate: 'sum',
  public: false,
};

describe('sport engine properties', () => {
  it('ranks timed results independently of entry order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 100_000 }), {
          minLength: 2,
          maxLength: 12,
        }),
        (times) => {
          const format = {
            format: 'multi_timed' as const,
            events: [{ key: 'race', label: { en: 'Race', es: 'Carrera' } }],
            lowerIsBetter: true as const,
            precision: 'seconds' as const,
            heats: false,
            lanes: 12,
          };
          const entries = times.map((value, index) => ({
            id: String(index),
            value,
          }));
          const first = rankTimed(format, entries);
          const reversed = rankTimed(format, [...entries].reverse());
          for (const row of first)
            expect(reversed.find((item) => item.id === row.id)?.place).toBe(
              row.place,
            );
        },
      ),
    );
  });

  it('never scores incomplete cross-country or golf teams', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (count) => {
        const placements = Array.from({ length: count }, (_, index) => ({
          id: String(index),
          teamId: 'a',
          place: index + 1,
          value: 70 + index,
          points: 0,
          status: 'ok' as const,
        }));
        expect(scoreCrossCountryTeams(placements, count + 1).has('a')).toBe(
          false,
        );
        expect(scoreGolfTeams(placements, count + 1).has('a')).toBe(false);
        expect(
          scoreCrossCountryTeams(placements, count).get('a'),
        ).toBeGreaterThan(0);
      }),
    );
  });

  it('sums stats independently of event entry order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(100), { minLength: 1, maxLength: 20 }),
        (values) => {
          const entries = values.map((value) => ({
            subjectId: 'a',
            values: { points: value },
          }));
          expect(aggregateStats([points], entries)).toEqual(
            aggregateStats([points], [...entries].reverse()),
          );
        },
      ),
    );
  });

  it('keeps standings stable when finalized matches are reordered', () => {
    fc.assert(
      fc.property(fc.nat(20), fc.nat(20), (first, second) => {
        const config = builtInSportTemplates.find(
          (template) => template.key === 'soccer',
        )?.defaultStandings;
        if (!config) throw new Error('Soccer standings missing');
        const base = {
          stage: 'regular' as const,
          finalized: true,
          countsForStandings: true,
        };
        const contests: StandingContest[] = [
          {
            ...base,
            homeTeamId: 'a',
            awayTeamId: 'b',
            homeScore: first,
            awayScore: second,
          },
          {
            ...base,
            homeTeamId: 'b',
            awayTeamId: 'a',
            homeScore: second,
            awayScore: first,
          },
        ];
        expect(computeStandings(['a', 'b'], contests, config)).toEqual(
          computeStandings(['a', 'b'], [...contests].reverse(), config),
        );
      }),
    );
  });

  it('round-trips every built-in template through the profile schema', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: builtInSportTemplates.length - 1 }),
        (index) => {
          const profile = builtInSportTemplates[index];
          expect(sportProfileSchema.parse(profile)).toEqual(profile);
        },
      ),
    );
  });
});
