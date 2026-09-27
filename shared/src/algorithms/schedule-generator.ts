import { Temporal } from '@js-temporal/polyfill';

export type GeneratorTeam = {
  id: string;
  coachIds: readonly string[];
  blackoutDates: readonly string[];
  householdIds?: readonly string[];
  homeSpaceId?: string;
  clubId?: string;
};
export type GeneratorDivision = {
  id: string;
  teamIds: readonly string[];
  gamesPerTeam?: number;
  roundRobin?: 'once' | 'twice';
  allowedWeekdays: readonly number[];
  timeWindows: readonly { start: string; end: string }[];
  preferredStartMinutes?: number;
  ageOrder?: number;
};
export type GeneratorSpace = {
  id: string;
  facilityId: string;
  suitableDivisionIds: readonly string[];
  conflictSpaceIds?: readonly string[];
  availability: readonly { startsAt: string; endsAt: string }[];
  blackouts?: readonly { startsAt: string; endsAt: string }[];
  bookings?: readonly { startsAt: string; endsAt: string }[];
};
export type GeneratorInput = {
  divisions: readonly GeneratorDivision[];
  teams: readonly GeneratorTeam[];
  spaces: readonly GeneratorSpace[];
  seasonStartsOn: string;
  seasonEndsOn: string;
  timezone: string;
  durationMinutes: number;
  bufferMinutes: number;
  maxGamesPerTeamPerDay?: number;
  maxGamesPerTeamPerWeek?: number;
  minRestHours?: number;
  seed: number;
  timeBudgetSeconds?: number;
  weights?: Partial<PenaltyWeights>;
};
export type Pairing = {
  id: string;
  divisionId: string;
  round: number;
  homeTeamId: string;
  awayTeamId: string;
};
export type DraftEvent = Pairing & {
  spaceId: string;
  facilityId: string;
  startsAt: string;
  endsAt: string;
  blockedUntil: string;
  localDate: string;
};
export type UnscheduledGame = Pairing & { reasons: string[] };
export type TeamScheduleMetrics = {
  teamId: string;
  home: number;
  away: number;
  gamesPerWeek: Record<string, number>;
  earliestLocalTime: string | null;
  latestLocalTime: string | null;
};
export type GeneratorOutput = {
  draftEvents: DraftEvent[];
  unscheduled: UnscheduledGame[];
  totalPenalty: number;
  teamMetrics: TeamScheduleMetrics[];
};
export type TournamentReservation = {
  id: string;
  round: number;
  homePlaceholder: string;
  awayPlaceholder: string;
  spaceId: string;
  startsAt: string;
  endsAt: string;
  blockedUntil: string;
};
export type TournamentOutput = GeneratorOutput & {
  bracketReservations: TournamentReservation[];
  unscheduledBracketSlots: {
    round: number;
    position: number;
    reason: string;
  }[];
};
export type PenaltyWeights = {
  homeAwayImbalance: number;
  weeklySpread: number;
  preferredTime: number;
  siblingDifferentFacility: number;
  siblingSameFacility: number;
  repeatOpponent: number;
  homeSpace: number;
  sameClubEarly: number;
};

const defaultWeights: PenaltyWeights = {
  homeAwayImbalance: 10,
  weeklySpread: 5,
  preferredTime: 1,
  siblingDifferentFacility: 8,
  siblingSameFacility: 3,
  repeatOpponent: 4,
  homeSpace: 2,
  sameClubEarly: 3,
};
const minuteMs = 60_000;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function rotate(ids: string[]): string[] {
  return [ids[0] ?? '', ids[ids.length - 1] ?? '', ...ids.slice(1, -1)];
}

export function circlePairings(division: GeneratorDivision): Pairing[] {
  if (new Set(division.teamIds).size !== division.teamIds.length)
    throw new RangeError('Duplicate team in division');
  if (division.teamIds.length < 2) return [];
  const ids = [
    ...division.teamIds,
    ...(division.teamIds.length % 2 ? ['__bye__'] : []),
  ];
  const rounds = ids.length - 1;
  const cycles =
    division.roundRobin === 'twice'
      ? 2
      : division.gamesPerTeam !== undefined
        ? Math.ceil(
            division.gamesPerTeam /
              (division.teamIds.length % 2 ? rounds - 1 : rounds),
          )
        : 1;
  const target =
    division.gamesPerTeam ??
    (division.roundRobin === 'twice' ? 2 : 1) * (division.teamIds.length - 1);
  if (!Number.isSafeInteger(target) || target < 0)
    throw new RangeError('Invalid games per team');
  const games: Pairing[] = [];
  const counts = new Map(division.teamIds.map((id) => [id, 0]));
  let order = ids;
  for (
    let cycle = 0;
    cycle < Math.max(cycles, 1) &&
    [...counts.values()].some((count) => count < target);
    cycle += 1
  ) {
    for (let round = 0; round < rounds; round += 1) {
      for (let i = 0; i < ids.length / 2; i += 1) {
        const first = order[i];
        const second = order[ids.length - 1 - i];
        if (!first || !second || first === '__bye__' || second === '__bye__')
          continue;
        if (
          (counts.get(first) ?? 0) >= target ||
          (counts.get(second) ?? 0) >= target
        )
          continue;
        const mirror = cycle % 2 === 1;
        const flip = (round + i) % 2 === 1;
        const home = mirror !== flip ? second : first;
        const away = mirror !== flip ? first : second;
        games.push({
          id: `${division.id}:${String(games.length + 1)}`,
          divisionId: division.id,
          round: cycle * rounds + round + 1,
          homeTeamId: home,
          awayTeamId: away,
        });
        counts.set(first, (counts.get(first) ?? 0) + 1);
        counts.set(second, (counts.get(second) ?? 0) + 1);
      }
      order = rotate(order);
    }
  }
  return games;
}

type Slot = {
  spaceId: string;
  facilityId: string;
  startsAt: string;
  endsAt: string;
  blockedUntil: string;
  startsAtEpochMs: number;
  endsAtEpochMs: number;
  localDate: string;
  localMinutes: number;
  weekday: number;
  weekKey: string;
};
type LocalParts = ReturnType<typeof localParts>;
type LocalPartsLookup = (instant: string) => LocalParts;
type EpochMillisecondsLookup = (instant: string) => number;

function createLocalPartsLookup(timezone: string): LocalPartsLookup {
  const byInstant = new Map<string, LocalParts>();
  return (instant) => {
    const cached = byInstant.get(instant);
    if (cached) return cached;
    const parts = localParts(instant, timezone);
    byInstant.set(instant, parts);
    return parts;
  };
}

function createEpochMillisecondsLookup(): EpochMillisecondsLookup {
  const byInstant = new Map<string, number>();
  return (instant) => {
    const cached = byInstant.get(instant);
    if (cached !== undefined) return cached;
    const milliseconds = Date.parse(instant);
    if (!Number.isFinite(milliseconds))
      throw new RangeError('Invalid schedule instant');
    byInstant.set(instant, milliseconds);
    return milliseconds;
  };
}

function overlaps(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
function weekKey(date: Temporal.PlainDate): string {
  return `${String(date.yearOfWeek)}-W${String(date.weekOfYear).padStart(2, '0')}`;
}
function localParts(
  instant: string,
  timezone: string,
): { date: string; minutes: number; weekday: number; week: string } {
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone);
  return {
    date: zoned.toPlainDate().toString(),
    minutes: zoned.hour * 60 + zoned.minute,
    weekday: zoned.dayOfWeek,
    week: weekKey(zoned.toPlainDate()),
  };
}

export function expandSpaceSlots(input: GeneratorInput): Slot[] {
  const slots: Slot[] = [];
  const localPartsAt = createLocalPartsLookup(input.timezone);
  for (const space of input.spaces) {
    for (const window of space.availability) {
      const start = Temporal.Instant.from(window.startsAt).epochMilliseconds;
      const end = Temporal.Instant.from(window.endsAt).epochMilliseconds;
      const first = Math.ceil(start / (15 * minuteMs)) * 15 * minuteMs;
      for (
        let ms = first;
        ms + (input.durationMinutes + input.bufferMinutes) * minuteMs <= end;
        ms += 15 * minuteMs
      ) {
        const startsAt = Temporal.Instant.fromEpochMilliseconds(ms).toString();
        const endsAt = Temporal.Instant.fromEpochMilliseconds(
          ms + input.durationMinutes * minuteMs,
        ).toString();
        const blockedUntil = Temporal.Instant.fromEpochMilliseconds(
          ms + (input.durationMinutes + input.bufferMinutes) * minuteMs,
        ).toString();
        const related = input.spaces.filter(
          (other) =>
            other.id === space.id ||
            space.conflictSpaceIds?.includes(other.id) ||
            other.conflictSpaceIds?.includes(space.id),
        );
        if (
          related.some((other) =>
            [...(other.blackouts ?? []), ...(other.bookings ?? [])].some(
              (blocked) =>
                overlaps(
                  startsAt,
                  blockedUntil,
                  blocked.startsAt,
                  blocked.endsAt,
                ),
            ),
          )
        )
          continue;
        const local = localPartsAt(startsAt);
        if (
          local.date < input.seasonStartsOn ||
          local.date > input.seasonEndsOn
        )
          continue;
        slots.push({
          spaceId: space.id,
          facilityId: space.facilityId,
          startsAt,
          endsAt,
          blockedUntil,
          startsAtEpochMs: ms,
          endsAtEpochMs: ms + input.durationMinutes * minuteMs,
          localDate: local.date,
          localMinutes: local.minutes,
          weekday: local.weekday,
          weekKey: local.week,
        });
      }
    }
  }
  return slots.sort(
    (a, b) =>
      a.startsAt.localeCompare(b.startsAt) ||
      a.spaceId.localeCompare(b.spaceId),
  );
}

function asEvent(pairing: Pairing, slot: Slot): DraftEvent {
  return {
    ...pairing,
    spaceId: slot.spaceId,
    facilityId: slot.facilityId,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    blockedUntil: slot.blockedUntil,
    localDate: slot.localDate,
  };
}

function hardAllowed(
  pairing: Pairing,
  slot: Slot,
  assigned: readonly DraftEvent[],
  input: GeneratorInput,
  teamById: Map<string, GeneratorTeam>,
  spaceById: Map<string, GeneratorSpace>,
  divisionById: Map<string, GeneratorDivision>,
  localPartsAt: LocalPartsLookup,
  epochMillisecondsAt: EpochMillisecondsLookup,
): boolean {
  const division = divisionById.get(pairing.divisionId);
  const space = spaceById.get(slot.spaceId);
  const home = teamById.get(pairing.homeTeamId);
  const away = teamById.get(pairing.awayTeamId);
  if (!division || !space || !home || !away) return false;
  if (
    !space.suitableDivisionIds.includes(division.id) ||
    !division.allowedWeekdays.includes(slot.weekday)
  )
    return false;
  if (
    !division.timeWindows.some(
      (window) =>
        slot.localMinutes >=
          Number(window.start.slice(0, 2)) * 60 +
            Number(window.start.slice(3)) &&
        slot.localMinutes + input.durationMinutes <=
          Number(window.end.slice(0, 2)) * 60 + Number(window.end.slice(3)),
    )
  )
    return false;
  if (
    home.blackoutDates.includes(slot.localDate) ||
    away.blackoutDates.includes(slot.localDate)
  )
    return false;
  const currentIds = [home.id, away.id];
  const coaches = new Set([...home.coachIds, ...away.coachIds]);
  const maxDay = input.maxGamesPerTeamPerDay ?? 1;
  const maxWeek = input.maxGamesPerTeamPerWeek ?? Number.POSITIVE_INFINITY;
  const restMs = (input.minRestHours ?? 0) * 60 * minuteMs;
  const sameDayGames = new Map(currentIds.map((teamId) => [teamId, 0]));
  const sameWeekGames = new Map(currentIds.map((teamId) => [teamId, 0]));
  for (const event of assigned) {
    const existingSpace = spaceById.get(event.spaceId);
    const spaceConflict =
      event.spaceId === slot.spaceId ||
      space.conflictSpaceIds?.includes(event.spaceId) ||
      existingSpace?.conflictSpaceIds?.includes(slot.spaceId);
    if (
      spaceConflict &&
      overlaps(
        slot.startsAt,
        slot.blockedUntil,
        event.startsAt,
        event.blockedUntil,
      )
    )
      return false;
    const eventTeams = [event.homeTeamId, event.awayTeamId];
    const sharedTeams = currentIds.filter((id) => eventTeams.includes(id));
    const sharedTeam = sharedTeams.length > 0;
    if (sharedTeam) {
      const eventSlot = localPartsAt(event.startsAt);
      for (const teamId of sharedTeams) {
        if (eventSlot.date === slot.localDate) {
          const count = (sameDayGames.get(teamId) ?? 0) + 1;
          sameDayGames.set(teamId, count);
          if (count >= maxDay) return false;
        }
        if (eventSlot.week === slot.weekKey) {
          const count = (sameWeekGames.get(teamId) ?? 0) + 1;
          sameWeekGames.set(teamId, count);
          if (count >= maxWeek) return false;
        }
      }
    }
    const otherHome = teamById.get(event.homeTeamId);
    const otherAway = teamById.get(event.awayTeamId);
    const sharedCoach = [
      ...(otherHome?.coachIds ?? []),
      ...(otherAway?.coachIds ?? []),
    ].some((id) => coaches.has(id));
    let gapMs: number | undefined;
    if (sharedTeam) {
      gapMs = Math.max(
        slot.startsAtEpochMs - epochMillisecondsAt(event.endsAt),
        epochMillisecondsAt(event.startsAt) - slot.endsAtEpochMs,
      );
      if (gapMs < restMs) return false;
    }
    if (sharedCoach) {
      const travelMs = event.facilityId === slot.facilityId ? 0 : 30 * minuteMs;
      gapMs ??= Math.max(
        slot.startsAtEpochMs - epochMillisecondsAt(event.endsAt),
        epochMillisecondsAt(event.startsAt) - slot.endsAtEpochMs,
      );
      if (gapMs < travelMs) return false;
    }
  }
  return true;
}

function penalty(
  events: readonly DraftEvent[],
  input: GeneratorInput,
  teamById: Map<string, GeneratorTeam>,
  divisionById: Map<string, GeneratorDivision>,
  localPartsAt: LocalPartsLookup,
): number {
  const w = { ...defaultWeights, ...input.weights };
  let total = 0;
  for (const team of input.teams) {
    const games = events
      .filter(
        (event) => event.homeTeamId === team.id || event.awayTeamId === team.id,
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const home = games.filter((game) => game.homeTeamId === team.id).length;
    total +=
      Math.max(0, Math.abs(home - (games.length - home)) - 1) *
      w.homeAwayImbalance;
    if (team.homeSpaceId)
      total +=
        games.filter(
          (game) =>
            game.homeTeamId === team.id && game.spaceId !== team.homeSpaceId,
        ).length * w.homeSpace;
    const perWeek = new Map<string, number>();
    games.forEach((game) => {
      const key = localPartsAt(game.startsAt).week;
      perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
    });
    if (perWeek.size > 1) {
      const mean = games.length / perWeek.size;
      total +=
        [...perWeek.values()].reduce(
          (sum, count) => sum + (count - mean) ** 2,
          0,
        ) * w.weeklySpread;
    }
    for (let i = 1; i < games.length; i += 1) {
      const prev = games[i - 1];
      const current = games[i];
      if (
        prev &&
        current &&
        (prev.homeTeamId === team.id ? prev.awayTeamId : prev.homeTeamId) ===
          (current.homeTeamId === team.id
            ? current.awayTeamId
            : current.homeTeamId)
      )
        total += w.repeatOpponent;
    }
  }
  for (const event of events) {
    const division = divisionById.get(event.divisionId);
    const local = localPartsAt(event.startsAt);
    if (division?.preferredStartMinutes !== undefined)
      total +=
        (Math.abs(local.minutes - division.preferredStartMinutes) / 30) *
        w.preferredTime;
    const home = teamById.get(event.homeTeamId);
    const away = teamById.get(event.awayTeamId);
    if (event.round <= 2 && home?.clubId && home.clubId === away?.clubId)
      total += w.sameClubEarly;
  }
  const chronological = [...events].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  );
  for (let i = 0; i < chronological.length; i += 1)
    for (let j = i + 1; j < chronological.length; j += 1) {
      const a = chronological[i];
      const b = chronological[j];
      if (!a || !b || a.endsAt <= b.startsAt) break;
      const aHouseholds = new Set([
        ...(teamById.get(a.homeTeamId)?.householdIds ?? []),
        ...(teamById.get(a.awayTeamId)?.householdIds ?? []),
      ]);
      if (
        [
          ...(teamById.get(b.homeTeamId)?.householdIds ?? []),
          ...(teamById.get(b.awayTeamId)?.householdIds ?? []),
        ].some((id) => aHouseholds.has(id))
      )
        total +=
          a.facilityId === b.facilityId
            ? w.siblingSameFacility
            : w.siblingDifferentFacility;
    }
  return total;
}

function incrementalPenalty(
  pairing: Pairing,
  slot: Slot,
  assigned: readonly DraftEvent[],
  input: GeneratorInput,
  teamById: Map<string, GeneratorTeam>,
  divisionById: Map<string, GeneratorDivision>,
  localPartsAt: LocalPartsLookup,
): number {
  const w = { ...defaultWeights, ...input.weights };
  const home = teamById.get(pairing.homeTeamId);
  const away = teamById.get(pairing.awayTeamId);
  const division = divisionById.get(pairing.divisionId);
  let value =
    division?.preferredStartMinutes === undefined
      ? 0
      : (Math.abs(slot.localMinutes - division.preferredStartMinutes) / 30) *
        w.preferredTime;
  if (home?.homeSpaceId && home.homeSpaceId !== slot.spaceId)
    value += w.homeSpace;
  if (pairing.round <= 2 && home?.clubId && home.clubId === away?.clubId)
    value += w.sameClubEarly;
  for (const teamId of [pairing.homeTeamId, pairing.awayTeamId]) {
    const prior = assigned.filter(
      (event) => event.homeTeamId === teamId || event.awayTeamId === teamId,
    );
    const currentHome =
      prior.filter((event) => event.homeTeamId === teamId).length +
      (teamId === pairing.homeTeamId ? 1 : 0);
    value +=
      Math.max(0, Math.abs(2 * currentHome - (prior.length + 1)) - 1) *
      w.homeAwayImbalance;
    value +=
      prior.filter(
        (event) => localPartsAt(event.startsAt).week === slot.weekKey,
      ).length * w.weeklySpread;
    const previous = [...prior].sort((a, b) =>
      b.startsAt.localeCompare(a.startsAt),
    )[0];
    if (
      previous &&
      (previous.homeTeamId === teamId
        ? previous.awayTeamId
        : previous.homeTeamId) ===
        (teamId === pairing.homeTeamId
          ? pairing.awayTeamId
          : pairing.homeTeamId)
    )
      value += w.repeatOpponent;
  }
  const households = new Set([
    ...(home?.householdIds ?? []),
    ...(away?.householdIds ?? []),
  ]);
  for (const event of assigned) {
    if (!overlaps(slot.startsAt, slot.endsAt, event.startsAt, event.endsAt))
      continue;
    const others = [
      ...(teamById.get(event.homeTeamId)?.householdIds ?? []),
      ...(teamById.get(event.awayTeamId)?.householdIds ?? []),
    ];
    if (others.some((id) => households.has(id)))
      value +=
        slot.facilityId === event.facilityId
          ? w.siblingSameFacility
          : w.siblingDifferentFacility;
  }
  return value;
}

function metrics(
  events: readonly DraftEvent[],
  input: GeneratorInput,
  localPartsAt: LocalPartsLookup,
): TeamScheduleMetrics[] {
  return input.teams.map((team) => {
    const games = events.filter(
      (event) => event.homeTeamId === team.id || event.awayTeamId === team.id,
    );
    const times = games
      .map((game) => {
        const local = localPartsAt(game.startsAt).minutes;
        return `${String(Math.floor(local / 60)).padStart(2, '0')}:${String(local % 60).padStart(2, '0')}`;
      })
      .sort();
    const gamesPerWeek: Record<string, number> = {};
    games.forEach((game) => {
      const key = localPartsAt(game.startsAt).week;
      gamesPerWeek[key] = (gamesPerWeek[key] ?? 0) + 1;
    });
    return {
      teamId: team.id,
      home: games.filter((game) => game.homeTeamId === team.id).length,
      away: games.filter((game) => game.awayTeamId === team.id).length,
      gamesPerWeek,
      earliestLocalTime: times[0] ?? null,
      latestLocalTime: times[times.length - 1] ?? null,
    };
  });
}

function balanceHomeAway(events: readonly DraftEvent[]): DraftEvent[] {
  type Vertex = string | symbol;
  type Edge = {
    eventIndex: number;
    from: Vertex;
    to: Vertex;
    virtual: boolean;
  };
  type Traversal = { from: Vertex; to: Vertex; edgeIndex: number };

  const balanced = [...events];
  const indexesByDivision = new Map<string, number[]>();
  events.forEach((event, index) => {
    const indexes = indexesByDivision.get(event.divisionId) ?? [];
    indexes.push(index);
    indexesByDivision.set(event.divisionId, indexes);
  });

  for (const indexes of indexesByDivision.values()) {
    const edges: Edge[] = indexes.flatMap((eventIndex) => {
      const event = events[eventIndex];
      return event
        ? [
            {
              eventIndex,
              from: event.homeTeamId,
              to: event.awayTeamId,
              virtual: false,
            },
          ]
        : [];
    });
    const degree = new Map<Vertex, number>();
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    const oddTeams = [...degree.entries()]
      .filter(([, count]) => count % 2 === 1)
      .map(([teamId]) => teamId)
      .filter((teamId): teamId is string => typeof teamId === 'string')
      .sort();
    // Pair odd-degree teams through a dummy vertex, then orient each Euler tour.
    const dummy = Symbol('home-away-balance');
    for (const teamId of oddTeams)
      edges.push({
        eventIndex: -1,
        from: dummy,
        to: teamId,
        virtual: true,
      });

    const adjacency = new Map<Vertex, number[]>();
    edges.forEach((edge, edgeIndex) => {
      const from = adjacency.get(edge.from) ?? [];
      from.push(edgeIndex);
      adjacency.set(edge.from, from);
      const to = adjacency.get(edge.to) ?? [];
      to.push(edgeIndex);
      adjacency.set(edge.to, to);
    });

    const used = new Set<number>();
    const orientCircuit = (start: Vertex): void => {
      const vertices: Vertex[] = [start];
      const traversals: Traversal[] = [];
      const circuit: Traversal[] = [];
      while (vertices.length) {
        const current = vertices.at(-1);
        if (current === undefined) break;
        const edgeIndex = (adjacency.get(current) ?? []).find(
          (index) => !used.has(index),
        );
        if (edgeIndex !== undefined) {
          const edge = edges[edgeIndex];
          if (!edge) continue;
          used.add(edgeIndex);
          const other = edge.from === current ? edge.to : edge.from;
          vertices.push(other);
          traversals.push({ from: current, to: other, edgeIndex });
        } else {
          vertices.pop();
          const traversal = traversals.pop();
          if (traversal) circuit.push(traversal);
        }
      }
      for (const traversal of circuit.reverse()) {
        const edge = edges[traversal.edgeIndex];
        if (
          !edge ||
          edge.virtual ||
          typeof traversal.from !== 'string' ||
          typeof traversal.to !== 'string'
        )
          continue;
        const event = balanced[edge.eventIndex];
        if (!event) continue;
        balanced[edge.eventIndex] = {
          ...event,
          homeTeamId: traversal.from,
          awayTeamId: traversal.to,
        };
      }
    };

    for (const [vertex, incidentEdges] of adjacency) {
      if (incidentEdges.some((edgeIndex) => !used.has(edgeIndex)))
        orientCircuit(vertex);
    }
  }
  return balanced;
}

export function generateSchedule(input: GeneratorInput): GeneratorOutput {
  if (
    !Number.isSafeInteger(input.durationMinutes) ||
    input.durationMinutes <= 0 ||
    !Number.isSafeInteger(input.bufferMinutes) ||
    input.bufferMinutes < 0
  )
    throw new RangeError('Invalid duration or buffer');
  const budget = input.timeBudgetSeconds ?? 45;
  if (!Number.isFinite(budget) || budget < 0 || budget > 120)
    throw new RangeError('Time budget must be between 0 and 120 seconds');
  const teamById = new Map(input.teams.map((team) => [team.id, team]));
  const spaceById = new Map(input.spaces.map((space) => [space.id, space]));
  const divisionById = new Map(
    input.divisions.map((division) => [division.id, division]),
  );
  const localPartsAt = createLocalPartsLookup(input.timezone);
  const epochMillisecondsAt = createEpochMillisecondsLookup();
  const pairings = input.divisions.flatMap(circlePairings);
  const slots = expandSpaceSlots(input);
  const feasible = (pairing: Pairing, events: readonly DraftEvent[]): Slot[] =>
    slots.filter((slot) =>
      hardAllowed(
        pairing,
        slot,
        events,
        input,
        teamById,
        spaceById,
        divisionById,
        localPartsAt,
        epochMillisecondsAt,
      ),
    );
  const ordered = [...pairings].sort(
    (a, b) =>
      feasible(a, []).length - feasible(b, []).length ||
      (divisionById.get(a.divisionId)?.ageOrder ?? 0) -
        (divisionById.get(b.divisionId)?.ageOrder ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const assigned: DraftEvent[] = [];
  const unscheduled: Pairing[] = [];
  for (const pairing of ordered) {
    const candidates = feasible(pairing, assigned);
    if (!candidates.length) {
      unscheduled.push(pairing);
      continue;
    }
    const stride = Math.max(1, Math.ceil(candidates.length / 128));
    const sampled = candidates.filter((_, index) => index % stride === 0);
    const chosen = sampled.reduce((best, slot) =>
      incrementalPenalty(
        pairing,
        slot,
        assigned,
        input,
        teamById,
        divisionById,
        localPartsAt,
      ) <
      incrementalPenalty(
        pairing,
        best,
        assigned,
        input,
        teamById,
        divisionById,
        localPartsAt,
      )
        ? slot
        : best,
    );
    assigned.push(asEvent(pairing, chosen));
  }
  const rng = random(input.seed);
  let currentPenalty = penalty(
    assigned,
    input,
    teamById,
    divisionById,
    localPartsAt,
  );
  const iterations = Math.floor(
    Math.min(budget * 200, 100_000 / Math.max(1, assigned.length)),
  );
  for (let step = 0; step < iterations && assigned.length; step += 1) {
    const index = Math.floor(rng() * assigned.length);
    const source = assigned[index];
    if (!source) continue;
    const others = assigned.filter((_, position) => position !== index);
    const move = Math.floor(rng() * 3);
    let proposal: DraftEvent[];
    if (move === 0) {
      const candidates = feasible(source, others);
      const slot = candidates[Math.floor(rng() * candidates.length)];
      if (!slot) continue;
      proposal = [...others, asEvent(source, slot)];
    } else if (move === 1 && assigned.length > 1) {
      const otherIndex = Math.floor(rng() * assigned.length);
      const target = assigned[otherIndex];
      if (!target || target.id === source.id) continue;
      const slotsByKey = new Map(
        slots.map((slot) => [`${slot.spaceId}:${slot.startsAt}`, slot]),
      );
      const a = slotsByKey.get(`${target.spaceId}:${target.startsAt}`);
      const b = slotsByKey.get(`${source.spaceId}:${source.startsAt}`);
      if (!a || !b) continue;
      proposal = assigned.filter(
        (_, position) => position !== index && position !== otherIndex,
      );
      const movedA = asEvent(source, a);
      const movedB = asEvent(target, b);
      if (
        !hardAllowed(
          movedA,
          a,
          proposal,
          input,
          teamById,
          spaceById,
          divisionById,
          localPartsAt,
          epochMillisecondsAt,
        ) ||
        !hardAllowed(
          movedB,
          b,
          [...proposal, movedA],
          input,
          teamById,
          spaceById,
          divisionById,
          localPartsAt,
          epochMillisecondsAt,
        )
      )
        continue;
      proposal.push(movedA, movedB);
    } else {
      proposal = [
        ...others,
        {
          ...source,
          homeTeamId: source.awayTeamId,
          awayTeamId: source.homeTeamId,
        },
      ];
    }
    const proposedPenalty = penalty(
      proposal,
      input,
      teamById,
      divisionById,
      localPartsAt,
    );
    const temperature = 50 * (0.1 / 50) ** (step / Math.max(1, iterations - 1));
    if (
      proposedPenalty <= currentPenalty ||
      rng() < Math.exp((currentPenalty - proposedPenalty) / temperature)
    ) {
      assigned.splice(0, assigned.length, ...proposal);
      currentPenalty = proposedPenalty;
    }
    if (step % 1000 === 999 && unscheduled.length) {
      for (let i = unscheduled.length - 1; i >= 0; i -= 1) {
        const pairing = unscheduled[i];
        if (!pairing) continue;
        const slot = feasible(pairing, assigned)[0];
        if (slot) {
          assigned.push(asEvent(pairing, slot));
          unscheduled.splice(i, 1);
          currentPenalty = penalty(
            assigned,
            input,
            teamById,
            divisionById,
            localPartsAt,
          );
        }
      }
    }
  }
  assigned.sort(
    (a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
  );
  const balancedAssigned = balanceHomeAway(assigned);
  return {
    draftEvents: balancedAssigned,
    unscheduled: unscheduled.map((pairing) => ({
      ...pairing,
      reasons: feasible(pairing, []).length
        ? [
            'Available slots conflict with existing games, team rest, coaches, or space bookings.',
          ]
        : [
            'No suitable space and time window remains after availability and blackouts.',
          ],
    })),
    totalPenalty: penalty(
      balancedAssigned,
      input,
      teamById,
      divisionById,
      localPartsAt,
    ),
    teamMetrics: metrics(balancedAssigned, input, localPartsAt),
  };
}

export function generateTournamentSchedule(
  input: GeneratorInput,
  poolDays: readonly string[],
  matchesPerBracketRound: readonly number[],
): TournamentOutput {
  if (
    !poolDays.length ||
    !matchesPerBracketRound.length ||
    matchesPerBracketRound.some(
      (count) => !Number.isSafeInteger(count) || count < 1,
    )
  )
    throw new RangeError('Tournament requires pool days and bracket rounds');
  const days = new Set(poolDays);
  const poolInput: GeneratorInput = {
    ...input,
    spaces: input.spaces.map((space) => ({
      ...space,
      availability: space.availability.filter((window) =>
        days.has(localParts(window.startsAt, input.timezone).date),
      ),
    })),
  };
  const pool = generateSchedule(poolInput);
  const finalPoolDay = [...poolDays].sort().at(-1);
  if (!finalPoolDay) throw new RangeError('Tournament requires pool days');
  const bracketSlots = expandSpaceSlots(input)
    .filter((slot) => slot.localDate > finalPoolDay)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const reservations: TournamentReservation[] = [];
  const unscheduledBracketSlots: TournamentOutput['unscheduledBracketSlots'] =
    [];
  const spaceById = new Map(input.spaces.map((space) => [space.id, space]));
  let previousRoundEnds = pool.draftEvents.reduce(
    (latest, event) => (event.endsAt > latest ? event.endsAt : latest),
    '0000-01-01T00:00:00Z',
  );
  matchesPerBracketRound.forEach((count, roundIndex) => {
    let roundEnd = previousRoundEnds;
    for (let position = 0; position < count; position += 1) {
      const restMs = (input.minRestHours ?? 0) * 60 * minuteMs;
      const slot = bracketSlots.find((candidate) => {
        if (
          Temporal.Instant.from(candidate.startsAt).epochMilliseconds -
            Temporal.Instant.from(previousRoundEnds).epochMilliseconds <
          restMs
        )
          return false;
        const candidateSpace = spaceById.get(candidate.spaceId);
        return !reservations.some((reservation) => {
          const reservedSpace = spaceById.get(reservation.spaceId);
          const conflict =
            reservation.spaceId === candidate.spaceId ||
            candidateSpace?.conflictSpaceIds?.includes(reservation.spaceId) ||
            reservedSpace?.conflictSpaceIds?.includes(candidate.spaceId);
          return (
            conflict &&
            overlaps(
              candidate.startsAt,
              candidate.blockedUntil,
              reservation.startsAt,
              reservation.blockedUntil,
            )
          );
        });
      });
      if (!slot) {
        unscheduledBracketSlots.push({
          round: roundIndex + 1,
          position: position + 1,
          reason: 'No bracket slot satisfies space and rest constraints.',
        });
        continue;
      }
      reservations.push({
        id: `B${String(roundIndex + 1)}-${String(position + 1)}`,
        round: roundIndex + 1,
        homePlaceholder:
          roundIndex === 0
            ? `Pool seed ${String(position * 2 + 1)}`
            : `Winner of B${String(roundIndex)}-${String(position * 2 + 1)}`,
        awayPlaceholder:
          roundIndex === 0
            ? `Pool seed ${String(position * 2 + 2)}`
            : `Winner of B${String(roundIndex)}-${String(position * 2 + 2)}`,
        spaceId: slot.spaceId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        blockedUntil: slot.blockedUntil,
      });
      if (slot.endsAt > roundEnd) roundEnd = slot.endsAt;
    }
    previousRoundEnds = roundEnd;
  });
  return {
    ...pool,
    bracketReservations: reservations,
    unscheduledBracketSlots,
  };
}
