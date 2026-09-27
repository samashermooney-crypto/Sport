import {
  type ContestStage,
  type StandingsConfig,
  type Tiebreaker,
} from './schema.js';

export type StandingContest = {
  homeTeamId: string;
  awayTeamId: string;
  homeDivisionId?: string;
  awayDivisionId?: string;
  stage: ContestStage;
  finalized: boolean;
  countsForStandings: boolean;
  homeScore: number;
  awayScore: number;
  homeSets?: number;
  awaySets?: number;
  homeSetPoints?: number;
  awaySetPoints?: number;
  overtimeWinner?: 'home' | 'away';
  forfeitBy?: 'home' | 'away';
  homeDisciplinePoints?: number;
  awayDisciplinePoints?: number;
  homeTries?: number;
  awayTries?: number;
  homeBallsFaced?: number;
  awayBallsFaced?: number;
};

export type StandingRow = {
  teamId: string;
  rank: number;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  overtimeWins: number;
  overtimeLosses: number;
  forfeits: number;
  scored: number;
  allowed: number;
  differential: number;
  setsWon: number;
  setsLost: number;
  setPointsFor: number;
  setPointsAgainst: number;
  points: number;
  winPercentage: number;
  disciplinePoints: number;
  ballsFaced: number;
  ballsBowled: number;
  runsForRate: number;
  runsAgainstRate: number;
  netRunRate: number;
  decidedBy: Tiebreaker | 'primary' | null;
  manualTiebreakRequired: boolean;
};

type MutableRow = Omit<
  StandingRow,
  'rank' | 'decidedBy' | 'manualTiebreakRequired'
>;

function emptyRow(teamId: string): MutableRow {
  return {
    teamId,
    played: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    overtimeWins: 0,
    overtimeLosses: 0,
    forfeits: 0,
    scored: 0,
    allowed: 0,
    differential: 0,
    setsWon: 0,
    setsLost: 0,
    setPointsFor: 0,
    setPointsAgainst: 0,
    points: 0,
    winPercentage: 0,
    disciplinePoints: 0,
    ballsFaced: 0,
    ballsBowled: 0,
    runsForRate: 0,
    runsAgainstRate: 0,
    netRunRate: 0,
  };
}

function scoreContest(
  rows: Map<string, MutableRow>,
  contest: StandingContest,
  config: StandingsConfig,
): void {
  const home = rows.get(contest.homeTeamId);
  const away = rows.get(contest.awayTeamId);
  if (!home || !away) return;
  if (contest.homeTeamId === contest.awayTeamId)
    throw new RangeError('A team cannot play itself');
  const homeScore = contest.forfeitBy
    ? contest.forfeitBy === 'home'
      ? config.forfeitScore.loser
      : config.forfeitScore.winner
    : contest.homeScore;
  const awayScore = contest.forfeitBy
    ? contest.forfeitBy === 'away'
      ? config.forfeitScore.loser
      : config.forfeitScore.winner
    : contest.awayScore;
  if (
    ![homeScore, awayScore].every(
      (score) => Number.isFinite(score) && score >= 0,
    )
  )
    throw new RangeError('Invalid contest score');
  const capped =
    config.maxGoalDifferential === undefined
      ? homeScore - awayScore
      : Math.max(
          -config.maxGoalDifferential,
          Math.min(config.maxGoalDifferential, homeScore - awayScore),
        );
  const setBasis =
    config.basis === 'set' &&
    contest.homeSets !== undefined &&
    contest.awaySets !== undefined &&
    !contest.forfeitBy;
  if (config.basis === 'set' && !setBasis && !contest.forfeitBy)
    throw new RangeError('Set standings require set totals');
  home.played += setBasis
    ? (contest.homeSets ?? 0) + (contest.awaySets ?? 0)
    : 1;
  away.played += setBasis
    ? (contest.homeSets ?? 0) + (contest.awaySets ?? 0)
    : 1;
  home.scored += homeScore;
  home.allowed += awayScore;
  away.scored += awayScore;
  away.allowed += homeScore;
  home.differential += capped;
  away.differential -= capped;
  home.setsWon += contest.homeSets ?? 0;
  home.setsLost += contest.awaySets ?? 0;
  away.setsWon += contest.awaySets ?? 0;
  away.setsLost += contest.homeSets ?? 0;
  home.setPointsFor += contest.homeSetPoints ?? 0;
  home.setPointsAgainst += contest.awaySetPoints ?? 0;
  away.setPointsFor += contest.awaySetPoints ?? 0;
  away.setPointsAgainst += contest.homeSetPoints ?? 0;
  home.disciplinePoints += contest.homeDisciplinePoints ?? 0;
  away.disciplinePoints += contest.awayDisciplinePoints ?? 0;
  if (
    contest.homeBallsFaced !== undefined ||
    contest.awayBallsFaced !== undefined
  ) {
    if (
      ![contest.homeBallsFaced, contest.awayBallsFaced].every(
        (balls) => Number.isSafeInteger(balls) && (balls ?? 0) > 0,
      )
    )
      throw new RangeError('Both cricket innings require positive balls faced');
    home.ballsFaced += contest.homeBallsFaced ?? 0;
    home.ballsBowled += contest.awayBallsFaced ?? 0;
    away.ballsFaced += contest.awayBallsFaced ?? 0;
    away.ballsBowled += contest.homeBallsFaced ?? 0;
    home.runsForRate += homeScore;
    home.runsAgainstRate += awayScore;
    away.runsForRate += awayScore;
    away.runsAgainstRate += homeScore;
  }
  if (contest.forfeitBy === 'home') home.forfeits += 1;
  if (contest.forfeitBy === 'away') away.forfeits += 1;
  const winner = contest.forfeitBy
    ? contest.forfeitBy === 'home'
      ? 'away'
      : 'home'
    : homeScore === awayScore
      ? (contest.overtimeWinner ?? null)
      : homeScore > awayScore
        ? 'home'
        : 'away';
  if (setBasis) {
    home.wins += contest.homeSets ?? 0;
    home.losses += contest.awaySets ?? 0;
    away.wins += contest.awaySets ?? 0;
    away.losses += contest.homeSets ?? 0;
    home.points +=
      (contest.homeSets ?? 0) * config.points.win +
      (contest.awaySets ?? 0) * config.points.loss;
    away.points +=
      (contest.awaySets ?? 0) * config.points.win +
      (contest.homeSets ?? 0) * config.points.loss;
  } else if (!winner) {
    home.ties += 1;
    away.ties += 1;
    home.points += config.points.tie;
    away.points += config.points.tie;
  } else {
    const won = winner === 'home' ? home : away;
    const lost = winner === 'home' ? away : home;
    won.wins += 1;
    lost.losses += 1;
    const overtime = contest.overtimeWinner !== undefined;
    if (overtime) {
      won.overtimeWins += 1;
      lost.overtimeLosses += 1;
    }
    won.points += contest.forfeitBy
      ? config.points.forfeitWin
      : overtime
        ? config.points.overtimeWin
        : config.points.win;
    lost.points += contest.forfeitBy
      ? config.points.forfeitLoss
      : overtime
        ? config.points.overtimeLoss
        : config.points.loss;
  }
  if (contest.forfeitBy === 'home')
    home.points -= config.points.forfeitDeduction;
  if (contest.forfeitBy === 'away')
    away.points -= config.points.forfeitDeduction;
  if (config.bonusPoints && !contest.forfeitBy) {
    const { triesThreshold, losingMargin, bonusPoint } = config.bonusPoints;
    if (
      contest.homeTries !== undefined &&
      (!Number.isSafeInteger(contest.homeTries) || contest.homeTries < 0)
    )
      throw new RangeError('Invalid home try count');
    if (
      contest.awayTries !== undefined &&
      (!Number.isSafeInteger(contest.awayTries) || contest.awayTries < 0)
    )
      throw new RangeError('Invalid away try count');
    if ((contest.homeTries ?? 0) >= triesThreshold) home.points += bonusPoint;
    if ((contest.awayTries ?? 0) >= triesThreshold) away.points += bonusPoint;
    if (winner && Math.abs(homeScore - awayScore) <= losingMargin)
      (winner === 'home' ? away : home).points += bonusPoint;
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0
    ? numerator > 0
      ? Number.POSITIVE_INFINITY
      : 0
    : numerator / denominator;
}

function criterionValue(
  row: MutableRow,
  criterion: Tiebreaker,
  mini?: MutableRow,
): number {
  const source = criterion.startsWith('head_to_head')
    ? (mini ?? emptyRow(row.teamId))
    : row;
  switch (criterion) {
    case 'head_to_head_points':
      return source.points;
    case 'head_to_head_differential':
      return source.differential;
    case 'wins':
      return row.wins;
    case 'fewest_losses':
      return -row.losses;
    case 'differential':
      return row.differential;
    case 'scored':
      return row.scored;
    case 'fewest_allowed':
      return -row.allowed;
    case 'set_ratio':
      return ratio(row.setsWon, row.setsLost);
    case 'point_ratio':
      return ratio(row.setPointsFor, row.setPointsAgainst);
    case 'sets_won':
      return row.setsWon;
    case 'fewest_forfeits':
      return -row.forfeits;
    case 'fewest_discipline_points':
      return -row.disciplinePoints;
    case 'net_run_rate':
      return row.netRunRate;
    case 'coin_toss_manual':
      return 0;
  }
}

function primaryValue(row: MutableRow, config: StandingsConfig): number {
  return config.rankBy === 'points'
    ? row.points
    : config.rankBy === 'wins'
      ? row.wins
      : row.winPercentage;
}

export function computeStandings(
  teamIds: readonly string[],
  contests: readonly StandingContest[],
  config: StandingsConfig,
  options: { divisionId?: string; manualOrder?: readonly string[] } = {},
): StandingRow[] {
  if (new Set(teamIds).size !== teamIds.length)
    throw new RangeError('Duplicate team ID');
  const selected = contests.filter(
    (contest) =>
      contest.finalized &&
      contest.countsForStandings &&
      config.include.stages.includes(contest.stage) &&
      (config.include.crossDivision ||
        options.divisionId === undefined ||
        (contest.homeDivisionId === options.divisionId &&
          contest.awayDivisionId === options.divisionId)),
  );
  const rows = new Map(teamIds.map((id) => [id, emptyRow(id)]));
  selected.forEach((contest) => {
    scoreContest(rows, contest, config);
  });
  for (const row of rows.values()) {
    row.winPercentage = row.played
      ? (row.wins + config.winPercentageTieValue * row.ties) / row.played
      : 0;
    row.netRunRate =
      row.ballsFaced && row.ballsBowled
        ? 6 *
          (row.runsForRate / row.ballsFaced -
            row.runsAgainstRate / row.ballsBowled)
        : 0;
  }
  const manual = new Map(
    (options.manualOrder ?? []).map((id, index) => [id, index]),
  );
  const decided = new Map<string, Tiebreaker | 'primary' | null>();
  const unresolved = new Set<string>();
  const resolve = (group: MutableRow[], index: number): MutableRow[] => {
    if (group.length < 2) return group;
    if (index >= config.tiebreakers.length) {
      group.forEach((row) => {
        if (!manual.has(row.teamId)) unresolved.add(row.teamId);
      });
      return [...group].sort(
        (a, b) =>
          (manual.get(a.teamId) ?? Number.POSITIVE_INFINITY) -
            (manual.get(b.teamId) ?? Number.POSITIVE_INFINITY) ||
          a.teamId.localeCompare(b.teamId),
      );
    }
    const criterion = config.tiebreakers[index];
    if (!criterion) return group;
    if (criterion === 'coin_toss_manual') {
      const ordered = [...group].sort(
        (a, b) =>
          (manual.get(a.teamId) ?? Number.POSITIVE_INFINITY) -
            (manual.get(b.teamId) ?? Number.POSITIVE_INFINITY) ||
          a.teamId.localeCompare(b.teamId),
      );
      if (ordered.some((row) => !manual.has(row.teamId)))
        ordered.forEach((row) => {
          if (!manual.has(row.teamId)) unresolved.add(row.teamId);
        });
      else
        ordered.forEach((row) => {
          decided.set(row.teamId, criterion);
        });
      return ordered;
    }
    const mini = new Map(
      group.map((row) => [row.teamId, emptyRow(row.teamId)]),
    );
    if (criterion.startsWith('head_to_head'))
      selected.forEach((contest) => {
        scoreContest(mini, contest, config);
      });
    const sorted = [...group].sort((a, b) => {
      const av = criterionValue(a, criterion, mini.get(a.teamId));
      const bv = criterionValue(b, criterion, mini.get(b.teamId));
      return av === bv ? a.teamId.localeCompare(b.teamId) : bv > av ? 1 : -1;
    });
    const parts: MutableRow[][] = [];
    for (const row of sorted) {
      const last = parts[parts.length - 1];
      if (
        last &&
        criterionValue(
          last[0] ?? row,
          criterion,
          mini.get(last[0]?.teamId ?? ''),
        ) === criterionValue(row, criterion, mini.get(row.teamId))
      )
        last.push(row);
      else parts.push([row]);
    }
    if (parts.length === 1) return resolve(group, index + 1);
    const result: MutableRow[] = [];
    for (const part of parts) {
      if (part.length === 1 && part[0]) {
        decided.set(part[0].teamId, criterion);
        result.push(part[0]);
      } else result.push(...resolve(part, 0));
    }
    return result;
  };
  const primarySorted = [...rows.values()].sort(
    (a, b) =>
      primaryValue(b, config) - primaryValue(a, config) ||
      a.teamId.localeCompare(b.teamId),
  );
  const primaryGroups: MutableRow[][] = [];
  for (const row of primarySorted) {
    const last = primaryGroups[primaryGroups.length - 1];
    if (
      last &&
      primaryValue(last[0] ?? row, config) === primaryValue(row, config)
    )
      last.push(row);
    else primaryGroups.push([row]);
  }
  const ordered = primaryGroups.flatMap((group) =>
    group.length === 1 ? group : resolve(group, 0),
  );
  return ordered.map((row, index) => ({
    ...row,
    rank: index + 1,
    decidedBy:
      decided.get(row.teamId) ??
      (primaryGroups.some(
        (group) => group.length === 1 && group[0]?.teamId === row.teamId,
      )
        ? 'primary'
        : null),
    manualTiebreakRequired: unresolved.has(row.teamId),
  }));
}
