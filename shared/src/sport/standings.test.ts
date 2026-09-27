import { describe, expect, it } from 'vitest';

import { type StandingsConfig } from './schema.js';
import { computeStandings, type StandingContest } from './standings.js';

const config: StandingsConfig = {
  basis: 'match',
  points: {
    win: 3,
    overtimeWin: 2,
    tie: 1,
    overtimeLoss: 1,
    loss: 0,
    forfeitWin: 3,
    forfeitLoss: 0,
    forfeitDeduction: 1,
  },
  rankBy: 'points',
  winPercentageTieValue: 0.5,
  forfeitScore: { winner: 3, loser: 0 },
  maxGoalDifferential: 2,
  tiebreakers: [
    'head_to_head_points',
    'head_to_head_differential',
    'differential',
    'coin_toss_manual',
  ],
  include: { stages: ['regular'], crossDivision: false },
  columns: ['rank', 'team', 'played', 'points'],
  publicVisibility: 'public',
};
function match(
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number,
  awayScore: number,
  extra: Partial<StandingContest> = {},
): StandingContest {
  return {
    homeTeamId,
    awayTeamId,
    homeScore,
    awayScore,
    stage: 'regular',
    finalized: true,
    countsForStandings: true,
    homeDivisionId: 'u12',
    awayDivisionId: 'u12',
    ...extra,
  };
}

describe('standings', () => {
  it('awards rugby try and narrow-loss bonuses without crediting forfeits', () => {
    const rugby = {
      ...config,
      bonusPoints: { triesThreshold: 4, losingMargin: 7, bonusPoint: 1 },
    };
    const rows = computeStandings(
      ['a', 'b'],
      [match('a', 'b', 25, 21, { homeTries: 4, awayTries: 3 })],
      rugby,
    );
    expect(rows.find((row) => row.teamId === 'a')?.points).toBe(4);
    expect(rows.find((row) => row.teamId === 'b')?.points).toBe(1);
    const forfeited = computeStandings(
      ['a', 'b'],
      [match('a', 'b', 25, 21, { forfeitBy: 'away', homeTries: 4 })],
      rugby,
    );
    expect(forfeited.find((row) => row.teamId === 'a')?.points).toBe(3);
    const bothTries = computeStandings(
      ['a', 'b'],
      [match('a', 'b', 25, 21, { homeTries: 4, awayTries: 4 })],
      rugby,
    );
    expect(bothTries.find((row) => row.teamId === 'b')?.points).toBe(2);
    expect(() =>
      computeStandings(
        ['a', 'b'],
        [match('a', 'b', 25, 21, { homeTries: -1 })],
        rugby,
      ),
    ).toThrow();
    expect(() =>
      computeStandings(
        ['a', 'b'],
        [match('a', 'b', 25, 21, { awayTries: 1.5 })],
        rugby,
      ),
    ).toThrow();
  });

  it('uses cricket net run rate over actual innings for tied points', () => {
    const cricket = { ...config, tiebreakers: ['net_run_rate' as const] };
    const rows = computeStandings(
      ['a', 'b', 'c'],
      [
        match('a', 'b', 120, 100, { homeBallsFaced: 120, awayBallsFaced: 120 }),
        match('b', 'c', 120, 100, { homeBallsFaced: 120, awayBallsFaced: 120 }),
        match('c', 'a', 150, 100, { homeBallsFaced: 120, awayBallsFaced: 120 }),
      ],
      cricket,
    );
    expect(rows.map((row) => row.teamId)).toEqual(['c', 'b', 'a']);
    expect(rows[0]?.netRunRate).toBeCloseTo(0.75);
    expect(() =>
      computeStandings(
        ['a', 'b'],
        [match('a', 'b', 1, 0, { homeBallsFaced: 12 })],
        cricket,
      ),
    ).toThrow();
  });
  it('counts finalized in-scope contests and caps per-match differential', () => {
    const rows = computeStandings(
      ['a', 'b'],
      [
        match('a', 'b', 8, 0),
        match('b', 'a', 2, 1, { finalized: false }),
        match('a', 'b', 2, 1, { stage: 'friendly' }),
      ],
      config,
      { divisionId: 'u12' },
    );
    expect(rows.map((row) => row.teamId)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({
      played: 1,
      wins: 1,
      points: 3,
      scored: 8,
      differential: 2,
      rank: 1,
    });
  });

  it('uses head-to-head points for a two-team primary tie', () => {
    const rows = computeStandings(
      ['a', 'b', 'c'],
      [match('a', 'b', 1, 0), match('b', 'c', 3, 0), match('c', 'a', 2, 0)],
      config,
    );
    expect(rows.map((row) => row.teamId)).toEqual(['b', 'c', 'a']);
    expect(rows.every((row) => row.points === 3)).toBe(true);
  });

  it('restarts tiebreakers when a three-team group separates', () => {
    const games = [
      match('a', 'b', 1, 0),
      match('a', 'c', 1, 0),
      match('b', 'c', 2, 0),
      match('c', 'a', 4, 0),
      match('b', 'a', 3, 0),
      match('c', 'b', 1, 0),
    ];
    const rows = computeStandings(['a', 'b', 'c'], games, config);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.rank)).size).toBe(3);
  });

  it('records missing manual tiebreaks instead of silently claiming a winner', () => {
    const rows = computeStandings(['a', 'b'], [], config);
    expect(rows.every((row) => row.manualTiebreakRequired)).toBe(true);
    expect(
      computeStandings(['a', 'b'], [], config, { manualOrder: ['b', 'a'] }).map(
        (row) => row.teamId,
      ),
    ).toEqual(['b', 'a']);
  });

  it('applies forfeit score, penalty and overtime points', () => {
    const rows = computeStandings(
      ['a', 'b'],
      [
        match('a', 'b', 0, 0, { forfeitBy: 'home' }),
        match('a', 'b', 1, 1, { overtimeWinner: 'home' }),
      ],
      config,
    );
    expect(rows.find((row) => row.teamId === 'a')).toMatchObject({
      forfeits: 1,
      overtimeWins: 1,
      points: 1,
    });
    expect(rows.find((row) => row.teamId === 'b')).toMatchObject({
      wins: 1,
      overtimeLosses: 1,
      points: 4,
    });
  });

  it('excludes cross-division contests when configured', () => {
    const rows = computeStandings(
      ['a', 'b'],
      [match('a', 'b', 1, 0, { awayDivisionId: 'u14' })],
      config,
      { divisionId: 'u12' },
    );
    expect(rows.every((row) => row.played === 0)).toBe(true);
  });

  it('can rank by sets instead of matches', () => {
    const setConfig: StandingsConfig = {
      ...config,
      basis: 'set',
      rankBy: 'win_percentage',
    };
    const rows = computeStandings(
      ['a', 'b'],
      [match('a', 'b', 2, 1, { homeSets: 2, awaySets: 1 })],
      setConfig,
    );
    expect(rows[0]).toMatchObject({
      teamId: 'a',
      played: 3,
      wins: 2,
      losses: 1,
      points: 6,
      winPercentage: 2 / 3,
    });
    expect(() =>
      computeStandings(['a', 'b'], [match('a', 'b', 2, 1)], setConfig),
    ).toThrow();
  });

  it('counts ties and away forfeits', () => {
    const rows = computeStandings(
      ['a', 'b'],
      [match('a', 'b', 1, 1), match('a', 'b', 0, 0, { forfeitBy: 'away' })],
      config,
    );
    expect(rows.find((row) => row.teamId === 'a')).toMatchObject({
      ties: 1,
      wins: 1,
      points: 4,
    });
    expect(rows.find((row) => row.teamId === 'b')).toMatchObject({
      ties: 1,
      forfeits: 1,
      points: 0,
    });
  });

  it.each([
    'wins',
    'fewest_losses',
    'differential',
    'scored',
    'fewest_allowed',
    'set_ratio',
    'point_ratio',
    'sets_won',
    'fewest_forfeits',
    'fewest_discipline_points',
  ] as const)('evaluates %s tiebreakers', (criterion) => {
    const zero: StandingsConfig = {
      ...config,
      points: {
        win: 0,
        overtimeWin: 0,
        tie: 0,
        overtimeLoss: 0,
        loss: 0,
        forfeitWin: 0,
        forfeitLoss: 0,
        forfeitDeduction: 0,
      },
      tiebreakers: [criterion, 'coin_toss_manual'],
    };
    const rows = computeStandings(
      ['a', 'b'],
      [
        match('a', 'b', 3, 1, {
          homeSets: 2,
          awaySets: 1,
          homeSetPoints: 50,
          awaySetPoints: 30,
          homeDisciplinePoints: 1,
          awayDisciplinePoints: 2,
        }),
      ],
      zero,
    );
    expect(rows).toHaveLength(2);
  });

  it('rejects duplicate teams and self-play', () => {
    expect(() => computeStandings(['a', 'a'], [], config)).toThrow();
    expect(() =>
      computeStandings(['a'], [match('a', 'a', 1, 0)], config),
    ).toThrow();
  });
});
