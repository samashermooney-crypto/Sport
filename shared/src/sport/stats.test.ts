import { describe, expect, it } from 'vitest';

import { type StatDefinition } from './schema.js';
import { aggregateStats, statLeaders } from './stats.js';

const text = { en: 'Goals', es: 'Goles' };
const goals: StatDefinition = {
  key: 'goals',
  label: text,
  abbreviation: 'G',
  level: 'athlete',
  valueType: 'integer',
  aggregate: 'sum',
  public: false,
};
const shots: StatDefinition = {
  key: 'shots',
  label: text,
  abbreviation: 'S',
  level: 'athlete',
  valueType: 'integer',
  aggregate: 'sum',
  public: false,
};
const percentage: StatDefinition = {
  key: 'conversion',
  label: text,
  abbreviation: 'C%',
  level: 'athlete',
  valueType: 'percentage',
  aggregate: 'average',
  derived: { formula: 'percentage', numerator: 'goals', denominator: 'shots' },
  public: false,
};

describe('sport stats', () => {
  it('aggregates base and derived values per subject', () => {
    const summaries = aggregateStats(
      [goals, shots, percentage],
      [
        { subjectId: 'a', values: { goals: 1, shots: 2 } },
        { subjectId: 'a', values: { goals: 2, shots: 4 } },
        { subjectId: 'b', values: { goals: 0, shots: 0 } },
      ],
    );
    expect(summaries).toEqual([
      { subjectId: 'a', values: { goals: 3, shots: 6, conversion: 50 } },
      { subjectId: 'b', values: { goals: 0, shots: 0, conversion: 0 } },
    ]);
    expect(
      statLeaders(goals, summaries, {
        youth: true,
        viewerCanSeePrivate: false,
      }),
    ).toEqual([]);
    expect(
      statLeaders(goals, summaries, {
        youth: true,
        viewerCanSeePrivate: true,
      })[0],
    ).toMatchObject({ subjectId: 'a', rank: 1 });
  });

  it('rejects invalid integer values and broken derived references', () => {
    expect(() =>
      aggregateStats([goals], [{ subjectId: 'a', values: { goals: 1.5 } }]),
    ).toThrow();
    expect(() =>
      aggregateStats([percentage], [{ subjectId: 'a', values: {} }]),
    ).toThrow();
  });
});
