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
});
