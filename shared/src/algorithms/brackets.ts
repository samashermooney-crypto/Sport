export type BracketEntrant = {
  id: string;
  seed: number;
  pool?: string;
  poolRank?: number;
  pointsPerGame?: number;
};
export type BracketSlot = {
  entrantId: string | null;
  sourceMatchId: string | null;
  sourceOutcome: 'winner' | 'loser' | null;
};
export type BracketMatch = {
  id: string;
  bracket: 'winners' | 'losers' | 'final';
  round: number;
  position: number;
  home: BracketSlot;
  away: BracketSlot;
  winnerId: string | null;
  finalized: boolean;
  winnerTo: { matchId: string; slot: 'home' | 'away' } | null;
  loserTo: { matchId: string; slot: 'home' | 'away' } | null;
};
export type Bracket = {
  kind: 'single' | 'double';
  size: number;
  matches: BracketMatch[];
  resetFinalId: string | null;
};

const empty = (): BracketSlot => ({
  entrantId: null,
  sourceMatchId: null,
  sourceOutcome: null,
});

export function nextPowerOfTwo(count: number): number {
  if (!Number.isSafeInteger(count) || count < 2 || count > 1024)
    throw new RangeError('Bracket requires 2–1024 entrants');
  let size = 2;
  while (size < count) size *= 2;
  return size;
}

export function seedPositions(size: number): number[] {
  if (size < 2 || size > 1024 || (size & (size - 1)) !== 0)
    throw new RangeError('Size must be a power of two from 2 to 1024');
  if (size === 2) return [1, 2];
  if (size === 4) return [1, 4, 2, 3];
  if (size === 8) return [1, 8, 4, 5, 3, 6, 2, 7];
  if (size === 16)
    return [1, 16, 8, 9, 5, 12, 4, 13, 6, 11, 3, 14, 7, 10, 2, 15];
  return seedPositions(size / 2).flatMap((seed) => [seed, size + 1 - seed]);
}

function entrantsBySeed(entrants: readonly BracketEntrant[]): {
  size: number;
  bySeed: Map<number, BracketEntrant>;
} {
  const size = nextPowerOfTwo(entrants.length);
  const sorted = [...entrants].sort((a, b) => a.seed - b.seed);
  if (
    new Set(sorted.map((entrant) => entrant.id)).size !== entrants.length ||
    new Set(sorted.map((entrant) => entrant.seed)).size !== entrants.length
  )
    throw new RangeError('Entrants and seeds must be unique');
  if (sorted.some((entrant, index) => entrant.seed !== index + 1))
    throw new RangeError('Seeds must be consecutive from 1');
  return {
    size,
    bySeed: new Map(sorted.map((entrant) => [entrant.seed, entrant])),
  };
}

function setTarget(
  source: BracketMatch,
  outcome: 'winner' | 'loser',
  target: BracketMatch,
  slot: 'home' | 'away',
): void {
  target[slot] = {
    entrantId: null,
    sourceMatchId: source.id,
    sourceOutcome: outcome,
  };
  if (outcome === 'winner') source.winnerTo = { matchId: target.id, slot };
  else source.loserTo = { matchId: target.id, slot };
}

export function generateSingleElimination(
  entrants: readonly BracketEntrant[],
): Bracket {
  const { size, bySeed } = entrantsBySeed(entrants);
  const positions = seedPositions(size);
  const rounds = Math.log2(size);
  const matches: BracketMatch[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const count = size / 2 ** round;
    for (let position = 0; position < count; position += 1) {
      const home =
        round === 1
          ? (bySeed.get(positions[position * 2] ?? 0)?.id ?? null)
          : null;
      const away =
        round === 1
          ? (bySeed.get(positions[position * 2 + 1] ?? 0)?.id ?? null)
          : null;
      matches.push({
        id: `W${String(round)}-${String(position + 1)}`,
        bracket: 'winners',
        round,
        position: position + 1,
        home: { ...empty(), entrantId: home },
        away: { ...empty(), entrantId: away },
        winnerId:
          round === 1 && (home === null || away === null)
            ? (home ?? away)
            : null,
        finalized: round === 1 && (home === null || away === null),
        winnerTo: null,
        loserTo: null,
      });
    }
  }
  for (let round = 1; round < rounds; round += 1) {
    const current = matches.filter((match) => match.round === round);
    const next = matches.filter((match) => match.round === round + 1);
    current.forEach((match, index) => {
      const target = next[Math.floor(index / 2)];
      if (!target) throw new Error('Bracket target missing');
      setTarget(match, 'winner', target, index % 2 === 0 ? 'home' : 'away');
      if (match.finalized)
        target[index % 2 === 0 ? 'home' : 'away'].entrantId = match.winnerId;
    });
  }
  return { kind: 'single', size, matches, resetFinalId: null };
}

export function generateDoubleElimination(
  entrants: readonly BracketEntrant[],
  resetFinal = true,
): Bracket {
  const single = generateSingleElimination(entrants);
  if (single.size < 4)
    throw new RangeError(
      'Double elimination requires at least four bracket slots',
    );
  const winners = single.matches;
  const k = Math.log2(single.size);
  const losers: BracketMatch[] = [];
  for (let round = 1; round <= 2 * k - 2; round += 1) {
    const count = single.size / 2 ** (Math.floor((round + 1) / 2) + 1);
    for (let position = 0; position < count; position += 1)
      losers.push({
        id: `L${String(round)}-${String(position + 1)}`,
        bracket: 'losers',
        round,
        position: position + 1,
        home: empty(),
        away: empty(),
        winnerId: null,
        finalized: false,
        winnerTo: null,
        loserTo: null,
      });
  }
  const losersRound = (round: number): BracketMatch[] =>
    losers.filter((match) => match.round === round);
  const winnersRound = (round: number): BracketMatch[] =>
    winners.filter((match) => match.round === round);
  winnersRound(1).forEach((match, index) => {
    const target = losersRound(1)[Math.floor(index / 2)];
    if (target)
      setTarget(match, 'loser', target, index % 2 === 0 ? 'home' : 'away');
  });
  for (let round = 2; round <= k; round += 1) {
    const targetRound = 2 * round - 2;
    winnersRound(round).forEach((match, index) => {
      const targets = losersRound(targetRound);
      const target = targets[targets.length - 1 - index];
      if (target) setTarget(match, 'loser', target, 'away');
    });
  }
  for (let round = 1; round < 2 * k - 2; round += 1) {
    const current = losersRound(round);
    const next = losersRound(round + 1);
    current.forEach((match, index) => {
      const target =
        next[Math.floor(index / (next.length === current.length ? 1 : 2))];
      if (target)
        setTarget(
          match,
          'winner',
          target,
          next.length === current.length
            ? 'home'
            : index % 2 === 0
              ? 'home'
              : 'away',
        );
    });
  }
  const championship: BracketMatch = {
    id: 'GF1',
    bracket: 'final',
    round: 1,
    position: 1,
    home: empty(),
    away: empty(),
    winnerId: null,
    finalized: false,
    winnerTo: null,
    loserTo: null,
  };
  const winnersFinal = winnersRound(k)[0];
  const losersFinal = losersRound(2 * k - 2)[0];
  if (!winnersFinal || !losersFinal) throw new Error('Bracket final missing');
  setTarget(winnersFinal, 'winner', championship, 'home');
  setTarget(losersFinal, 'winner', championship, 'away');
  const matches = [...winners, ...losers, championship];
  if (resetFinal)
    matches.push({
      id: 'GF2',
      bracket: 'final',
      round: 2,
      position: 1,
      home: { entrantId: null, sourceMatchId: 'GF1', sourceOutcome: 'winner' },
      away: { entrantId: null, sourceMatchId: 'GF1', sourceOutcome: 'loser' },
      winnerId: null,
      finalized: false,
      winnerTo: null,
      loserTo: null,
    });
  return {
    kind: 'double',
    size: single.size,
    matches,
    resetFinalId: resetFinal ? 'GF2' : null,
  };
}

export function crossSeedPools(
  entrants: readonly BracketEntrant[],
  mode: 'cross_pool' | 'overall',
): BracketEntrant[] {
  if (mode === 'overall')
    return [...entrants]
      .sort(
        (a, b) =>
          (b.pointsPerGame ?? 0) - (a.pointsPerGame ?? 0) ||
          (a.poolRank ?? 0) - (b.poolRank ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .map((entrant, index) => ({ ...entrant, seed: index + 1 }));
  const pools = [...new Set(entrants.map((entrant) => entrant.pool))].sort();
  if (pools.length !== 2)
    throw new RangeError('Cross-pool seeding requires two pools');
  const [poolA, poolB] = pools;
  const a = entrants
    .filter((entrant) => entrant.pool === poolA)
    .sort((x, y) => (x.poolRank ?? 0) - (y.poolRank ?? 0));
  const b = entrants
    .filter((entrant) => entrant.pool === poolB)
    .sort((x, y) => (x.poolRank ?? 0) - (y.poolRank ?? 0));
  if (a.length !== b.length || a.length === 0)
    throw new RangeError('Pools must have equal entries');
  const ordered = [a[0], b[0], ...a.slice(1), ...b.slice(1)].filter(
    (item): item is BracketEntrant => !!item,
  );
  return ordered.map((entrant, index) => ({ ...entrant, seed: index + 1 }));
}

export function finalizeBracketMatch(
  bracket: Bracket,
  matchId: string,
  winnerId: string,
): Bracket {
  const matches = structuredClone(bracket.matches);
  const match = matches.find((item) => item.id === matchId);
  if (!match) throw new RangeError('Match not found');
  const participants = [match.home.entrantId, match.away.entrantId];
  if (
    !participants.includes(winnerId) ||
    participants.some((id) => id === null)
  )
    throw new RangeError('Winner must be a participant in a complete match');
  const previousWinner = match.winnerId;
  if (match.id === 'GF1') {
    const reset = matches.find((item) => item.id === bracket.resetFinalId);
    if (reset?.finalized && previousWinner !== winnerId)
      throw new RangeError(
        'Cannot edit a final after its reset match is final',
      );
    if (reset) {
      const needed = winnerId === match.away.entrantId;
      reset.home.entrantId = needed ? match.home.entrantId : null;
      reset.away.entrantId = needed ? match.away.entrantId : null;
      reset.winnerId = null;
      reset.finalized = false;
    }
  }
  if (previousWinner && previousWinner !== winnerId) {
    const downstream = matches.find(
      (item) => item.id === match.winnerTo?.matchId,
    );
    if (downstream?.finalized)
      throw new RangeError(
        'Cannot edit a result after a downstream match is final',
      );
  }
  match.winnerId = winnerId;
  match.finalized = true;
  const loserId = participants.find((id) => id !== winnerId) ?? null;
  for (const [target, id] of [
    [match.winnerTo, winnerId],
    [match.loserTo, loserId],
  ] as const) {
    if (!target) continue;
    const downstream = matches.find((item) => item.id === target.matchId);
    if (!downstream) throw new Error('Bracket target missing');
    downstream[target.slot].entrantId = id;
    if (previousWinner && previousWinner !== winnerId) {
      downstream.winnerId = null;
      downstream.finalized = false;
    }
  }
  return { ...bracket, matches };
}
