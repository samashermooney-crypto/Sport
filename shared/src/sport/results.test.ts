import { describe, expect, it } from 'vitest';

import {
  computeBout,
  computeScore,
  computeSets,
  judgedTotal,
  rankJudged,
  rankMeasured,
  rankPlacementOnly,
  rankTimed,
  rollUpTeamPoints,
  scoreCrossCountryTeams,
  scoreGolfTeams,
} from './results.js';
import { type ContestFormatConfig } from './schema.js';

const text = { en: 'Score', es: 'Puntos' };
const score: Extract<ContestFormatConfig, { format: 'head_to_head_score' }> = {
  format: 'head_to_head_score',
  periods: { label: text, count: 2 },
  scoreLabel: text,
  allowTie: true,
  shootout: true,
  scoreDirection: 'higher_wins',
};
const sets: Extract<ContestFormatConfig, { format: 'head_to_head_sets' }> = {
  format: 'head_to_head_sets',
  bestOf: 3,
  pointsPerSet: 25,
  decidingSetPoints: 15,
  winBy: 2,
  scoringUnit: 'points',
};

describe('sport results', () => {
  it('validates score totals, ties, bracket decisions and forfeits', () => {
    expect(
      computeScore(score, 2, 1, {
        periods: [
          { home: 1, away: 0 },
          { home: 1, away: 1 },
        ],
      }).winner,
    ).toBe('home');
    expect(computeScore(score, 1, 1).outcome).toBe('tie');
    expect(() => computeScore(score, 1, 1, { bracket: true })).toThrow();
    expect(
      computeScore(score, 1, 1, { bracket: true, shootoutWinner: 'away' })
        .winner,
    ).toBe('away');
    expect(
      computeScore(score, 0, 0, {
        forfeitBy: 'home',
        forfeitScore: { winner: 3, loser: 0 },
      }),
    ).toMatchObject({ winner: 'away', home: 0, away: 3 });
    expect(() =>
      computeScore(score, 1, 1, { periods: [{ home: 0, away: 1 }] }),
    ).toThrow();
  });

  it('ends set matches only when one side wins the required number', () => {
    expect(
      computeSets(sets, [
        { home: 25, away: 20 },
        { home: 23, away: 25 },
        { home: 15, away: 13 },
      ]),
    ).toEqual({
      winner: 'home',
      homeSets: 2,
      awaySets: 1,
      homePoints: 63,
      awayPoints: 58,
    });
    expect(() =>
      computeSets(sets, [
        { home: 25, away: 24 },
        { home: 25, away: 20 },
      ]),
    ).toThrow();
    expect(() => computeSets(sets, [{ home: 25, away: 20 }])).toThrow();
    expect(() =>
      computeSets(sets, [
        { home: 25, away: 20 },
        { home: 25, away: 20 },
        { home: 15, away: 10 },
      ]),
    ).toThrow();
    expect(() =>
      computeSets(sets, [
        { home: 24, away: 22 },
        { home: 25, away: 20 },
      ]),
    ).toThrow('Set did not reach target');
    expect(
      computeSets({ ...sets, tiebreakAt: 25 }, [
        { home: 26, away: 25, tiebreakWinner: 'home' },
        { home: 25, away: 20 },
      ]).winner,
    ).toBe('home');
    expect(() =>
      computeSets({ ...sets, bestOf: 4 }, [
        { home: 25, away: 20 },
        { home: 20, away: 25 },
      ]),
    ).toThrow('Match is incomplete');
  });

  it('scores bout methods for team duals', () => {
    const format: Extract<
      ContestFormatConfig,
      { format: 'head_to_head_bout' }
    > = {
      format: 'head_to_head_bout',
      methods: [{ key: 'fall', label: text, teamPoints: 6 }],
      periods: { label: text, count: 3 },
    };
    expect(computeBout(format, 'away', 'fall')).toMatchObject({
      homeTeamPoints: 0,
      awayTeamPoints: 6,
    });
    expect(() => computeBout(format, 'home', 'unknown')).toThrow();
  });

  it('ranks timed events with competition ties and unplaced statuses', () => {
    const format: Extract<ContestFormatConfig, { format: 'multi_timed' }> = {
      format: 'multi_timed',
      events: [{ key: 'free', label: text }],
      lowerIsBetter: true,
      precision: 'hundredths',
      heats: true,
      lanes: 8,
      placePoints: [6, 4, 3, 2],
    };
    const ranked = rankTimed(format, [
      { id: 'a', teamId: 'red', value: 60000 },
      { id: 'b', teamId: 'blue', value: 61000 },
      { id: 'c', teamId: 'red', value: 61000 },
      { id: 'd', teamId: 'blue', value: 0, status: 'dq' },
      { id: 'e', teamId: 'blue', value: 63000 },
    ]);
    expect(ranked.map((entry) => entry.place)).toEqual([1, 2, 2, null, 4]);
    expect(rollUpTeamPoints(ranked)).toEqual(
      new Map([
        ['red', 10],
        ['blue', 6],
      ]),
    );
  });

  it('takes the best measured attempt in the configured direction', () => {
    const format: Extract<ContestFormatConfig, { format: 'multi_measured' }> = {
      format: 'multi_measured',
      events: [{ key: 'long_jump', label: text }],
      lowerIsBetter: false,
      unit: 'm',
      attempts: 3,
      placePoints: [5, 3],
    };
    expect(
      rankMeasured(format, [
        { id: 'a', attempts: [4.1, 4.5, 4.2] },
        { id: 'b', attempts: [4.3] },
        { id: 'c', attempts: [], status: 'dns' },
      ]).map((entry) => entry.place),
    ).toEqual([1, 2, null]);
    expect(() => rankMeasured(format, [{ id: 'a', attempts: [] }])).toThrow();
    expect(() =>
      rankMeasured(format, [{ id: 'a', attempts: [Number.NaN] }]),
    ).toThrow('Result value must be non-negative and finite');
  });

  it('drops high and low judge scores per component', () => {
    const format: Extract<ContestFormatConfig, { format: 'judged' }> = {
      format: 'judged',
      apparatusOrRoutines: [{ key: 'floor', label: text }],
      panel: {
        judges: 4,
        dropHighLow: true,
        components: [{ key: 'execution', label: text, max: 10 }],
        combine: 'average',
      },
      placePoints: [6, 4],
    };
    const sheets = [6, 8, 9, 10].map((value, index) => ({
      judgeId: String(index),
      components: { execution: value },
    }));
    expect(judgedTotal(format, sheets)).toBe(8.5);
    expect(rankJudged(format, [{ id: 'a', sheets }])[0]?.place).toBe(1);
    expect(() => judgedTotal(format, sheets.slice(1))).toThrow();
    expect(() =>
      judgedTotal(
        format,
        sheets.map((sheet, index) =>
          index === 0 ? { ...sheet, components: { execution: -1 } } : sheet,
        ),
      ),
    ).toThrow('Invalid score for execution');
  });

  it('preserves externally recorded placements', () => {
    expect(
      rankPlacementOnly(
        [
          { id: 'a', place: 1 },
          { id: 'b', place: 2 },
        ],
        [6, 4],
      ).map((entry) => entry.points),
    ).toEqual([6, 4]);
    expect(() => rankPlacementOnly([{ id: 'a', place: 0 }])).toThrow();
  });

  it('rejects invalid scores, sets, entrant IDs and judge sheets', () => {
    expect(() => computeScore(score, -1, 0)).toThrow();
    expect(() =>
      computeScore(score, 0, 0, {
        forfeitBy: 'home',
        forfeitScore: { winner: 0, loser: 0 },
      }),
    ).toThrow();
    expect(() =>
      computeScore({ ...score, shootout: false }, 1, 1, {
        shootoutWinner: 'home',
      }),
    ).toThrow();
    expect(() =>
      computeSets(sets, [
        { home: 25, away: 25 },
        { home: 25, away: 20 },
      ]),
    ).toThrow();
    expect(() =>
      computeSets({ ...sets, cap: 30 }, [
        { home: 31, away: 29 },
        { home: 25, away: 20 },
      ]),
    ).toThrow();
    const timedFormat: Extract<ContestFormatConfig, { format: 'multi_timed' }> =
      {
        format: 'multi_timed',
        events: [{ key: 'race', label: text }],
        lowerIsBetter: true,
        precision: 'seconds',
        heats: false,
        lanes: 1,
      };
    expect(() =>
      rankTimed(timedFormat, [
        { id: 'a', value: 1 },
        { id: 'a', value: 2 },
      ]),
    ).toThrow();
    expect(() => rankTimed(timedFormat, [{ id: 'a', value: -1 }])).toThrow();
    const measuredFormat: Extract<
      ContestFormatConfig,
      { format: 'multi_measured' }
    > = {
      format: 'multi_measured',
      events: [{ key: 'jump', label: text }],
      lowerIsBetter: false,
      unit: 'm',
      attempts: 1,
    };
    expect(() =>
      rankMeasured(measuredFormat, [{ id: 'a', attempts: [1, 2] }]),
    ).toThrow();
    expect(() =>
      rankPlacementOnly([
        { id: 'a', place: 1 },
        { id: 'a', place: 2 },
      ]),
    ).toThrow();
  });

  it('awards distinct relay points and rejects mixed individual results', () => {
    const format: Extract<ContestFormatConfig, { format: 'multi_timed' }> = {
      format: 'multi_timed',
      events: [{ key: 'relay', label: text, relay: true }],
      lowerIsBetter: true,
      precision: 'hundredths',
      heats: true,
      lanes: 8,
      placePoints: [6, 4, 3],
      relayPlacePoints: [8, 4, 2],
    };
    expect(
      rankTimed(format, [
        { id: 'a', value: 1000, relay: true },
        { id: 'b', value: 1100, relay: true },
      ]).map((row) => row.points),
    ).toEqual([8, 4]);
    expect(() =>
      rankTimed(format, [
        { id: 'a', value: 1000, relay: true },
        { id: 'b', value: 1100 },
      ]),
    ).toThrow();
  });

  it('multiplies diving execution by consistent degree of difficulty', () => {
    const format: Extract<ContestFormatConfig, { format: 'judged' }> = {
      format: 'judged',
      apparatusOrRoutines: [{ key: 'springboard', label: text }],
      panel: {
        judges: 4,
        dropHighLow: true,
        combine: 'sum',
        components: [
          { key: 'execution', label: text, max: 10 },
          { key: 'dd', label: text, max: 5 },
        ],
      },
    };
    const sheets = [6, 8, 9, 10].map((execution, index) => ({
      judgeId: String(index),
      components: { execution, dd: 2.5 },
    }));
    expect(judgedTotal(format, sheets)).toBe(42.5);
    expect(() =>
      judgedTotal(
        format,
        sheets.map((sheet, index) =>
          index
            ? sheet
            : { ...sheet, components: { ...sheet.components, dd: 3 } },
        ),
      ),
    ).toThrow();
  });

  it('scores only complete cross-country and golf teams using best N', () => {
    const placement = (
      id: string,
      teamId: string,
      place: number,
      value: number,
    ) => ({ id, teamId, place, value, status: 'ok' as const, points: 0 });
    const rows = [
      placement('a1', 'a', 1, 80),
      placement('a2', 'a', 5, 90),
      placement('a3', 'a', 4, 85),
      placement('b1', 'b', 2, 75),
    ];
    expect(scoreCrossCountryTeams(rows, 2).get('a')).toBe(5);
    expect(scoreCrossCountryTeams(rows, 2).has('b')).toBe(false);
    expect(scoreGolfTeams(rows, 2).get('a')).toBe(165);
    expect(() => scoreGolfTeams(rows, 0)).toThrow();
    expect(
      scoreGolfTeams(
        [
          { ...placement('disqualified', 'a', 1, 80), status: 'dq' },
          {
            id: 'unassigned',
            place: 1,
            value: 75,
            points: 0,
            status: 'ok',
          },
        ],
        1,
      ),
    ).toEqual(new Map());
    expect(() =>
      scoreGolfTeams([{ ...placement('invalid', 'a', 1, 80), value: null }], 1),
    ).toThrow('Team result must be non-negative and finite');
  });
});
