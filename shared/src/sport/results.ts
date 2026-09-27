import { type ContestFormatConfig } from './schema.js';

type ScoreFormat = Extract<
  ContestFormatConfig,
  { format: 'head_to_head_score' }
>;
type SetsFormat = Extract<ContestFormatConfig, { format: 'head_to_head_sets' }>;
type BoutFormat = Extract<ContestFormatConfig, { format: 'head_to_head_bout' }>;
type TimedFormat = Extract<ContestFormatConfig, { format: 'multi_timed' }>;
type MeasuredFormat = Extract<
  ContestFormatConfig,
  { format: 'multi_measured' }
>;
type JudgedFormat = Extract<ContestFormatConfig, { format: 'judged' }>;

export type Side = 'home' | 'away';
export type ScoreResult = {
  winner: Side | null;
  home: number;
  away: number;
  outcome: 'home_win' | 'away_win' | 'tie' | 'forfeit_win' | 'forfeit_loss';
  shootoutWinner: Side | null;
};
export type SetScore = { home: number; away: number; tiebreakWinner?: Side };
export type SetsResult = {
  winner: Side;
  homeSets: number;
  awaySets: number;
  homePoints: number;
  awayPoints: number;
};
export type BoutResult = {
  winner: Side;
  method: string;
  homeTeamPoints: number;
  awayTeamPoints: number;
};
export type RankedEntry = {
  id: string;
  teamId?: string | undefined;
  status?: 'ok' | 'dq' | 'dnf' | 'dns' | undefined;
  value: number;
  relay?: boolean;
};
export type Placement = {
  id: string;
  teamId?: string | undefined;
  place: number | null;
  value: number | null;
  points: number;
  status: 'ok' | 'dq' | 'dnf' | 'dns';
};
export type JudgeSheet = {
  judgeId: string;
  components: Record<string, number>;
};

function nonnegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${field} must be a non-negative safe integer`);
}

export function computeScore(
  format: ScoreFormat,
  home: number,
  away: number,
  options: {
    bracket?: boolean;
    periods?: readonly { home: number; away: number }[];
    shootoutWinner?: Side;
    forfeitBy?: Side;
    forfeitScore?: { winner: number; loser: number };
  } = {},
): ScoreResult {
  nonnegativeInteger(home, 'home score');
  nonnegativeInteger(away, 'away score');
  for (const period of options.periods ?? []) {
    nonnegativeInteger(period.home, 'period home score');
    nonnegativeInteger(period.away, 'period away score');
  }
  if (
    options.periods?.length &&
    (options.periods.reduce((sum, period) => sum + period.home, 0) !== home ||
      options.periods.reduce((sum, period) => sum + period.away, 0) !== away)
  )
    throw new RangeError('Period scores must equal totals');
  if (options.forfeitBy) {
    const winner = options.forfeitBy === 'home' ? 'away' : 'home';
    const score = options.forfeitScore ?? { winner: 1, loser: 0 };
    nonnegativeInteger(score.winner, 'forfeit winner score');
    nonnegativeInteger(score.loser, 'forfeit loser score');
    if (score.winner <= score.loser)
      throw new RangeError('Forfeit winner score must be greater');
    return {
      winner,
      home: winner === 'home' ? score.winner : score.loser,
      away: winner === 'away' ? score.winner : score.loser,
      outcome: 'forfeit_win',
      shootoutWinner: null,
    };
  }
  const winner =
    home > away
      ? 'home'
      : away > home
        ? 'away'
        : (options.shootoutWinner ?? null);
  if (home === away && !winner && (!format.allowTie || options.bracket))
    throw new RangeError('A decisive result is required');
  if (options.shootoutWinner && (!format.shootout || home !== away))
    throw new RangeError('Shootout is not valid for this score');
  return {
    winner,
    home,
    away,
    outcome:
      winner === 'home' ? 'home_win' : winner === 'away' ? 'away_win' : 'tie',
    shootoutWinner: options.shootoutWinner ?? null,
  };
}

function setWinner(format: SetsFormat, set: SetScore, deciding: boolean): Side {
  nonnegativeInteger(set.home, 'set home score');
  nonnegativeInteger(set.away, 'set away score');
  if (set.home === set.away) throw new RangeError('A set cannot end tied');
  const winner = set.home > set.away ? 'home' : 'away';
  const winning = Math.max(set.home, set.away);
  const losing = Math.min(set.home, set.away);
  const target = deciding ? format.decidingSetPoints : format.pointsPerSet;
  if (
    format.tiebreakAt !== undefined &&
    winning === format.tiebreakAt + 1 &&
    losing === format.tiebreakAt &&
    set.tiebreakWinner === winner
  )
    return winner;
  if (winning < target) throw new RangeError('Set did not reach target');
  if (format.cap !== undefined && winning > format.cap)
    throw new RangeError('Set exceeds cap');
  if (winning - losing < format.winBy && winning !== format.cap)
    throw new RangeError('Set does not meet win-by rule');
  return winner;
}

export function computeSets(
  format: SetsFormat,
  sets: readonly SetScore[],
): SetsResult {
  const needed = Math.ceil(format.bestOf / 2);
  if (sets.length < needed || sets.length > format.bestOf)
    throw new RangeError('Invalid number of sets');
  let homeSets = 0;
  let awaySets = 0;
  let homePoints = 0;
  let awayPoints = 0;
  sets.forEach((set, index) => {
    if (homeSets === needed || awaySets === needed)
      throw new RangeError('Set entered after match ended');
    const winner = setWinner(format, set, index === format.bestOf - 1);
    if (winner === 'home') homeSets += 1;
    else awaySets += 1;
    homePoints += set.home;
    awayPoints += set.away;
  });
  if (homeSets !== needed && awaySets !== needed)
    throw new RangeError('Match is incomplete');
  return {
    winner: homeSets === needed ? 'home' : 'away',
    homeSets,
    awaySets,
    homePoints,
    awayPoints,
  };
}

export function computeBout(
  format: BoutFormat,
  winner: Side,
  method: string,
): BoutResult {
  const selected = format.methods.find((item) => item.key === method);
  if (!selected) throw new RangeError('Unknown bout method');
  const points = selected.teamPoints ?? 0;
  return {
    winner,
    method,
    homeTeamPoints: winner === 'home' ? points : 0,
    awayTeamPoints: winner === 'away' ? points : 0,
  };
}

function rankEntries(
  entries: readonly RankedEntry[],
  lowerIsBetter: boolean,
  points: readonly number[] = [],
): Placement[] {
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length)
    throw new RangeError('Duplicate entrant');
  for (const entry of entries) {
    if (!Number.isFinite(entry.value) || entry.value < 0)
      throw new RangeError('Result value must be non-negative and finite');
  }
  const ranked = entries
    .filter((entry) => !entry.status || entry.status === 'ok')
    .sort((a, b) =>
      lowerIsBetter
        ? a.value - b.value || a.id.localeCompare(b.id)
        : b.value - a.value || a.id.localeCompare(b.id),
    );
  const positions = new Map<string, number>();
  ranked.forEach((entry, index) => {
    const previous = ranked[index - 1];
    positions.set(
      entry.id,
      previous && previous.value === entry.value
        ? (positions.get(previous.id) ?? index + 1)
        : index + 1,
    );
  });
  return entries.map((entry) => {
    const status = entry.status ?? 'ok';
    const place = status === 'ok' ? (positions.get(entry.id) ?? null) : null;
    return {
      id: entry.id,
      teamId: entry.teamId,
      place,
      value: status === 'ok' ? entry.value : null,
      points: place === null ? 0 : (points[place - 1] ?? 0),
      status,
    };
  });
}

export function rankTimed(
  format: TimedFormat,
  entries: readonly RankedEntry[],
): Placement[] {
  entries.forEach((entry) => {
    nonnegativeInteger(entry.value, 'time in milliseconds');
  });
  return rankEntries(entries, true, format.placePoints);
}

export function rankMeasured(
  format: MeasuredFormat,
  entries: readonly (Omit<RankedEntry, 'value'> & {
    attempts: readonly number[];
  })[],
): Placement[] {
  return rankEntries(
    entries.map((entry) => {
      if (
        format.attempts !== undefined &&
        entry.attempts.length > format.attempts
      )
        throw new RangeError('Too many attempts');
      if (!entry.attempts.length && (!entry.status || entry.status === 'ok'))
        throw new RangeError('At least one attempt required');
      return {
        id: entry.id,
        teamId: entry.teamId,
        status: entry.status,
        value: entry.attempts.length
          ? format.lowerIsBetter
            ? Math.min(...entry.attempts)
            : Math.max(...entry.attempts)
          : 0,
      };
    }),
    format.lowerIsBetter,
    format.placePoints,
  );
}

export function judgedTotal(
  format: JudgedFormat,
  sheets: readonly JudgeSheet[],
): number {
  if (
    sheets.length !== format.panel.judges ||
    new Set(sheets.map((sheet) => sheet.judgeId)).size !== sheets.length
  )
    throw new RangeError('Judge panel is incomplete or duplicated');
  let total = 0;
  for (const component of format.panel.components) {
    const scores = sheets.map((sheet) => sheet.components[component.key]);
    if (
      scores.some(
        (score) =>
          score === undefined ||
          !Number.isFinite(score) ||
          (component.key !== 'penalty' && score < 0) ||
          (component.max !== undefined && score > component.max),
      )
    )
      throw new RangeError(`Invalid score for ${component.key}`);
    const values = scores as number[];
    const retained =
      format.panel.dropHighLow && values.length >= 4
        ? [...values].sort((a, b) => a - b).slice(1, -1)
        : values;
    const sum = retained.reduce((acc, score) => acc + score, 0);
    total += format.panel.combine === 'average' ? sum / retained.length : sum;
  }
  return total;
}

export function rankJudged(
  format: JudgedFormat,
  entries: readonly {
    id: string;
    teamId?: string;
    sheets: readonly JudgeSheet[];
  }[],
): Placement[] {
  return rankEntries(
    entries.map((entry) => ({
      id: entry.id,
      teamId: entry.teamId,
      value: judgedTotal(format, entry.sheets),
    })),
    false,
    format.placePoints,
  );
}

export function rankPlacementOnly(
  entries: readonly { id: string; teamId?: string; place: number }[],
  points: readonly number[] = [],
): Placement[] {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new RangeError('Duplicate entrant');
  return entries.map((entry) => {
    if (!Number.isSafeInteger(entry.place) || entry.place < 1)
      throw new RangeError('Place must be a positive integer');
    return {
      id: entry.id,
      teamId: entry.teamId,
      place: entry.place,
      value: null,
      points: points[entry.place - 1] ?? 0,
      status: 'ok',
    };
  });
}

export function rollUpTeamPoints(
  placements: readonly Placement[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const placement of placements) {
    if (placement.teamId)
      totals.set(
        placement.teamId,
        (totals.get(placement.teamId) ?? 0) + placement.points,
      );
  }
  return totals;
}
