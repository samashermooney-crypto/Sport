export type BalancePlayer = {
  id: string;
  rating?: number | null;
  /** Age in whole years, for example at a program's start date. */
  age?: number | null;
  positions: readonly string[];
  fixedTeamId?: string;
  friendRequestId?: string;
  siblingGroupId?: string;
  returningTeamId?: string;
  school?: string;
  location?: string;
};
export type BalanceTeam = {
  id: string;
  maxRoster: number;
  minPositions?: Readonly<Record<string, number>>;
  preferredSchool?: string;
  preferredLocation?: string;
};
export type BalanceInput = {
  players: readonly BalancePlayer[];
  teams: readonly BalanceTeam[];
  siblingsTogether: boolean;
  returningStay: boolean;
  seed: number;
  timeBudgetSeconds?: number;
};
export type BalanceMetrics = {
  teamId: string;
  size: number;
  meanRating: number;
  meanAge?: number;
  totalRating: number;
  positionCoverageViolations: number;
  preferenceMisses: number;
};
export type BalanceOutput = {
  assignments: Record<string, string>;
  metrics: BalanceMetrics[];
  objective: number;
};

type Unit = {
  ids: string[];
  rating: number;
  age: number;
  fixedTeamId: string | null;
  players: BalancePlayer[];
};

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function stdev(values: readonly number[]): number {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );
}

function unitsFor(
  input: BalanceInput,
  medianRating: number,
  medianAge: number,
): Unit[] {
  const byId = new Map(input.players.map((player) => [player.id, player]));
  const parent = new Map(input.players.map((player) => [player.id, player.id]));
  const find = (id: string): string => {
    const prior = parent.get(id);
    if (!prior) throw new RangeError('Unknown player');
    if (prior === id) return id;
    const root = find(prior);
    parent.set(id, root);
    return root;
  };
  const unite = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const player of input.players) {
    const friend = player.friendRequestId
      ? byId.get(player.friendRequestId)
      : undefined;
    if (friend?.friendRequestId === player.id) unite(player.id, friend.id);
  }
  if (input.siblingsTogether) {
    const firstByGroup = new Map<string, string>();
    for (const player of input.players)
      if (player.siblingGroupId) {
        const first = firstByGroup.get(player.siblingGroupId);
        if (first) unite(first, player.id);
        else firstByGroup.set(player.siblingGroupId, player.id);
      }
  }
  const grouped = new Map<string, BalancePlayer[]>();
  for (const player of input.players)
    grouped.set(find(player.id), [
      ...(grouped.get(find(player.id)) ?? []),
      player,
    ]);
  return [...grouped.values()].map((players) => {
    const fixed = new Set(
      players
        .map(
          (player) =>
            player.fixedTeamId ??
            (input.returningStay ? player.returningTeamId : undefined),
        )
        .filter((id): id is string => !!id),
    );
    if (fixed.size > 1)
      throw new RangeError('Hard-linked players have conflicting fixed teams');
    return {
      ids: players.map((player) => player.id).sort(),
      rating: players.reduce(
        (sum, player) => sum + (player.rating ?? medianRating),
        0,
      ),
      age: players.reduce((sum, player) => sum + (player.age ?? medianAge), 0),
      fixedTeamId: [...fixed][0] ?? null,
      players,
    };
  });
}

function metricFor(
  team: BalanceTeam,
  units: readonly Unit[],
  medianRating: number,
  medianAge: number,
  includeAge: boolean,
): BalanceMetrics {
  const players = units.flatMap((unit) => unit.players);
  const totalRating = units.reduce((sum, unit) => sum + unit.rating, 0);
  let positionCoverageViolations = 0;
  for (const [position, required] of Object.entries(team.minPositions ?? {})) {
    positionCoverageViolations += Math.max(
      0,
      required -
        players.filter((player) => player.positions.includes(position)).length,
    );
  }
  const preferenceMisses = players.filter(
    (player) =>
      (team.preferredSchool &&
        player.school &&
        player.school !== team.preferredSchool) ||
      (team.preferredLocation &&
        player.location &&
        player.location !== team.preferredLocation),
  ).length;
  const metric: BalanceMetrics = {
    teamId: team.id,
    size: players.length,
    meanRating: players.length ? totalRating / players.length : medianRating,
    totalRating,
    positionCoverageViolations,
    preferenceMisses,
  };
  if (includeAge) {
    metric.meanAge = players.length
      ? units.reduce((sum, unit) => sum + unit.age, 0) / players.length
      : medianAge;
  }
  return metric;
}

function objective(
  input: BalanceInput,
  assigned: Map<string, Unit[]>,
  medianRating: number,
  medianAge: number,
  includeAge: boolean,
): { value: number; metrics: BalanceMetrics[] } {
  const metrics = input.teams.map((team) =>
    metricFor(
      team,
      assigned.get(team.id) ?? [],
      medianRating,
      medianAge,
      includeAge,
    ),
  );
  const returningSplit = input.returningStay
    ? 0
    : input.players.filter(
        (player) =>
          player.returningTeamId &&
          !assigned
            .get(player.returningTeamId)
            ?.some((unit) => unit.ids.includes(player.id)),
      ).length;
  return {
    value:
      stdev(metrics.map((metric) => metric.meanRating)) * 100 +
      (includeAge
        ? stdev(metrics.map((metric) => metric.meanAge ?? medianAge)) * 100
        : 0) +
      stdev(metrics.map((metric) => metric.size)) * 50 +
      metrics.reduce(
        (sum, metric) =>
          sum +
          metric.positionCoverageViolations * 1000 +
          metric.preferenceMisses * 2,
        0,
      ) +
      returningSplit * 5,
    metrics,
  };
}

export function balanceTeams(input: BalanceInput): BalanceOutput {
  if (!input.teams.length)
    throw new RangeError('At least one team is required');
  if (
    new Set(input.players.map((player) => player.id)).size !==
      input.players.length ||
    new Set(input.teams.map((team) => team.id)).size !== input.teams.length
  )
    throw new RangeError('Duplicate player or team ID');
  if (
    input.teams.some(
      (team) => !Number.isSafeInteger(team.maxRoster) || team.maxRoster < 1,
    )
  )
    throw new RangeError('Invalid roster maximum');
  if (
    input.players.some(
      (player) =>
        player.rating != null &&
        (!Number.isFinite(player.rating) || player.rating < 0),
    )
  )
    throw new RangeError('Invalid player rating');
  if (
    input.players.some(
      (player) =>
        player.age != null && (!Number.isFinite(player.age) || player.age < 0),
    )
  )
    throw new RangeError('Invalid player age');
  const budget = input.timeBudgetSeconds ?? 5;
  if (!Number.isFinite(budget) || budget < 0 || budget > 5)
    throw new RangeError('Time budget must be 0–5 seconds');
  const random = rng(input.seed);
  const medianRating = median(
    input.players.flatMap((player) =>
      player.rating == null ? [] : [player.rating],
    ),
  );
  const ages = input.players.flatMap((player) =>
    player.age == null ? [] : [player.age],
  );
  const includeAge = ages.length > 0;
  const medianAge = median(ages);
  const units = unitsFor(input, medianRating, medianAge);
  const assigned = new Map(input.teams.map((team) => [team.id, [] as Unit[]]));
  const maxFor = (teamId: string): number =>
    input.teams.find((team) => team.id === teamId)?.maxRoster ?? 0;
  const sizeFor = (teamId: string): number =>
    (assigned.get(teamId) ?? []).reduce(
      (sum, unit) => sum + unit.ids.length,
      0,
    );
  for (const unit of units.filter((item) => item.fixedTeamId)) {
    const id = unit.fixedTeamId;
    if (!id || !assigned.has(id) || sizeFor(id) + unit.ids.length > maxFor(id))
      throw new RangeError(
        'Fixed placement exceeds a team roster or names an unknown team',
      );
    assigned.get(id)?.push(unit);
  }
  const unplaced = units.filter((unit) => !unit.fixedTeamId);
  const needScore = (unit: Unit): number =>
    Math.max(
      ...input.teams.flatMap((team) =>
        Object.entries(team.minPositions ?? {}).map(([position, required]) =>
          unit.players.some((player) => player.positions.includes(position))
            ? required
            : 0,
        ),
      ),
      0,
    );
  unplaced.sort(
    (a, b) =>
      needScore(b) - needScore(a) ||
      b.rating - a.rating ||
      a.ids[0]?.localeCompare(b.ids[0] ?? '') ||
      0,
  );
  unplaced.forEach((unit, index) => {
    const choices = input.teams.filter(
      (team) => sizeFor(team.id) + unit.ids.length <= team.maxRoster,
    );
    if (!choices.length)
      throw new RangeError(
        'Insufficient roster capacity for linked player group',
      );
    const snake =
      Math.floor(index / input.teams.length) % 2 === 0
        ? input.teams
        : [...input.teams].reverse();
    choices.sort((a, b) => {
      const aUnits = assigned.get(a.id) ?? [];
      const bUnits = assigned.get(b.id) ?? [];
      const aRating = aUnits.reduce((sum, item) => sum + item.rating, 0);
      const bRating = bUnits.reduce((sum, item) => sum + item.rating, 0);
      const aNeed = Object.entries(a.minPositions ?? {}).reduce(
        (sum, [position, required]) =>
          sum +
          (unit.players.some((player) => player.positions.includes(position))
            ? Math.max(
                0,
                required -
                  aUnits
                    .flatMap((item) => item.players)
                    .filter((player) => player.positions.includes(position))
                    .length,
              )
            : 0),
        0,
      );
      const bNeed = Object.entries(b.minPositions ?? {}).reduce(
        (sum, [position, required]) =>
          sum +
          (unit.players.some((player) => player.positions.includes(position))
            ? Math.max(
                0,
                required -
                  bUnits
                    .flatMap((item) => item.players)
                    .filter((player) => player.positions.includes(position))
                    .length,
              )
            : 0),
        0,
      );
      return (
        bNeed - aNeed ||
        aRating - bRating ||
        snake.indexOf(a) - snake.indexOf(b)
      );
    });
    const chosen = choices[0];
    if (!chosen) throw new Error('No team choice');
    assigned.get(chosen.id)?.push(unit);
  });
  let best = objective(
    input,
    assigned,
    medianRating,
    medianAge,
    includeAge,
  ).value;
  const iterations = Math.floor(budget * 100);
  for (let step = 0; step < iterations; step += 1) {
    const firstTeam = input.teams[Math.floor(random() * input.teams.length)];
    const secondTeam = input.teams[Math.floor(random() * input.teams.length)];
    if (!firstTeam || !secondTeam || firstTeam.id === secondTeam.id) continue;
    const a = assigned.get(firstTeam.id) ?? [];
    const b = assigned.get(secondTeam.id) ?? [];
    const movableA = a.filter((unit) => !unit.fixedTeamId);
    const movableB = b.filter((unit) => !unit.fixedTeamId);
    const ua = movableA[Math.floor(random() * movableA.length)];
    const ub = movableB[Math.floor(random() * movableB.length)];
    if (
      !ua ||
      !ub ||
      sizeFor(firstTeam.id) - ua.ids.length + ub.ids.length >
        firstTeam.maxRoster ||
      sizeFor(secondTeam.id) - ub.ids.length + ua.ids.length >
        secondTeam.maxRoster
    )
      continue;
    a.splice(a.indexOf(ua), 1, ub);
    b.splice(b.indexOf(ub), 1, ua);
    const candidate = objective(
      input,
      assigned,
      medianRating,
      medianAge,
      includeAge,
    ).value;
    if (candidate < best) best = candidate;
    else {
      a.splice(a.indexOf(ub), 1, ua);
      b.splice(b.indexOf(ua), 1, ub);
    }
  }
  const metrics = objective(
    input,
    assigned,
    medianRating,
    medianAge,
    includeAge,
  ).metrics;
  const assignments = Object.fromEntries(
    [...assigned].flatMap(([teamId, teamUnits]) =>
      teamUnits.flatMap((unit) => unit.ids.map((id) => [id, teamId])),
    ),
  );
  return { assignments, metrics, objective: best };
}
