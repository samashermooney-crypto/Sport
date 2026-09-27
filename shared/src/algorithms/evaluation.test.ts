import { describe, expect, it } from 'vitest';

import { scoreEvaluations, type EvaluationInput } from './evaluation.js';

const base: EvaluationInput = {
  criteria: [
    { key: 'skill', weight: 2, scaleMin: 1, scaleMax: 5 },
    {
      key: 'goalkeeper',
      weight: 1,
      scaleMin: 1,
      scaleMax: 5,
      positionSpecific: true,
      positionKeys: ['gk'],
    },
  ],
  athletes: [
    { id: 'a', name: 'Ari', group: 'U12', positions: ['field'] },
    { id: 'b', name: 'Bea', group: 'U12', positions: ['gk'] },
  ],
  scores: [
    { athleteId: 'a', evaluatorId: 'one', criterionKey: 'skill', score: 4 },
    { athleteId: 'a', evaluatorId: 'two', criterionKey: 'skill', score: 5 },
    { athleteId: 'b', evaluatorId: 'one', criterionKey: 'skill', score: 4 },
    {
      athleteId: 'b',
      evaluatorId: 'one',
      criterionKey: 'goalkeeper',
      score: 5,
    },
  ],
  normalization: 'none',
};

describe('evaluation scoring', () => {
  it('weights applicable criteria, ranks groups and flags one-evaluator athletes', () => {
    const results = scoreEvaluations(base);
    expect(results.find((result) => result.athleteId === 'a')).toMatchObject({
      composite: 4.5,
      rankInGroup: 1,
      evaluatorCount: 2,
      needsSecondEvaluator: false,
    });
    expect(results.find((result) => result.athleteId === 'b')).toMatchObject({
      composite: 13 / 3,
      rankInGroup: 2,
      evaluatorCount: 1,
      needsSecondEvaluator: true,
    });
  });

  it('keeps incomplete athletes unranked', () => {
    const results = scoreEvaluations({
      ...base,
      scores: base.scores.filter(
        (score) => score.criterionKey !== 'goalkeeper',
      ),
    });
    expect(results.find((result) => result.athleteId === 'b')).toMatchObject({
      composite: null,
      rankInGroup: null,
      missingCriteria: ['goalkeeper'],
    });
  });

  it('normalizes an evaluator with at least eight scores', () => {
    const athletes = Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      name: String(index),
      group: 'all',
      positions: [],
    }));
    const scores = athletes.flatMap((athlete, index) => [
      {
        athleteId: athlete.id,
        evaluatorId: 'strict',
        criterionKey: 'skill',
        score: index + 1,
      },
      {
        athleteId: athlete.id,
        evaluatorId: 'lenient',
        criterionKey: 'skill',
        score: index + 3,
      },
    ]);
    const results = scoreEvaluations({
      criteria: [{ key: 'skill', weight: 1, scaleMin: 1, scaleMax: 10 }],
      athletes,
      scores,
      normalization: 'z_score_per_evaluator',
    });
    expect(results[0]?.criterionValues.skill).toBeCloseTo(1.6812, 3);
    expect(results[7]?.criterionValues.skill).toBeCloseTo(9.3188, 3);
  });

  it('rejects duplicate or out-of-scale scores', () => {
    expect(() =>
      scoreEvaluations({
        ...base,
        scores: [
          ...base.scores,
          base.scores[0] ?? {
            athleteId: 'a',
            evaluatorId: 'one',
            criterionKey: 'skill',
            score: 4,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      scoreEvaluations({
        ...base,
        scores: [
          {
            athleteId: 'a',
            evaluatorId: 'one',
            criterionKey: 'skill',
            score: 6,
          },
        ],
      }),
    ).toThrow();
  });

  it('uses centered raw scores when each evaluator has fewer than eight scores', () => {
    const results = scoreEvaluations({
      ...base,
      normalization: 'z_score_per_evaluator',
    });
    expect(
      results.find((result) => result.athleteId === 'a')?.criterionValues.skill,
    ).toBeCloseTo(13 / 3);
  });
});
