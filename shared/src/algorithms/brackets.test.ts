import { describe, expect, it } from 'vitest';

import {
  crossSeedPools,
  finalizeBracketMatch,
  generateDoubleElimination,
  generateSingleElimination,
  nextPowerOfTwo,
  seedPositions,
} from './brackets.js';

const entrants = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `team${String(index + 1)}`,
    seed: index + 1,
  }));

describe('bracket generation', () => {
  it('uses standard 16-seed placement and awards byes to top seeds', () => {
    expect(seedPositions(16)).toEqual([
      1, 16, 8, 9, 5, 12, 4, 13, 6, 11, 3, 14, 7, 10, 2, 15,
    ]);
    expect(nextPowerOfTwo(13)).toBe(16);
    const bracket = generateSingleElimination(entrants(13));
    expect(bracket.size).toBe(16);
    expect(
      bracket.matches
        .filter((match) => match.round === 1 && match.finalized)
        .map((match) => match.winnerId)
        .sort(),
    ).toEqual(['team1', 'team2', 'team3']);
  });

  it('advances winners and blocks edits after downstream finalization', () => {
    let bracket = generateSingleElimination(entrants(4));
    bracket = finalizeBracketMatch(bracket, 'W1-1', 'team1');
    bracket = finalizeBracketMatch(bracket, 'W1-2', 'team2');
    expect(
      bracket.matches.find((match) => match.id === 'W2-1')?.home.entrantId,
    ).toBe('team1');
    bracket = finalizeBracketMatch(bracket, 'W2-1', 'team1');
    expect(() => finalizeBracketMatch(bracket, 'W1-1', 'team4')).toThrow();
  });

  it('creates losers bracket and grand final with an optional reset', () => {
    const bracket = generateDoubleElimination(entrants(8));
    expect(
      bracket.matches
        .filter((match) => match.bracket === 'losers')
        .map((match) => match.id),
    ).toEqual(['L1-1', 'L1-2', 'L2-1', 'L2-2', 'L3-1', 'L4-1']);
    expect(
      bracket.matches.find((match) => match.id === 'W1-1')?.loserTo,
    ).toEqual({ matchId: 'L1-1', slot: 'home' });
    expect(bracket.resetFinalId).toBe('GF2');
  });

  it('opens a reset final only when the losers champion wins the first final', () => {
    const bracket = generateDoubleElimination(entrants(4));
    const withFinalists = structuredClone(bracket);
    const first = withFinalists.matches.find((match) => match.id === 'GF1');
    if (!first) throw new Error('Final missing');
    first.home.entrantId = 'team1';
    first.away.entrantId = 'team2';
    expect(
      finalizeBracketMatch(withFinalists, 'GF1', 'team1').matches.find(
        (match) => match.id === 'GF2',
      )?.home.entrantId,
    ).toBeNull();
    expect(
      finalizeBracketMatch(withFinalists, 'GF1', 'team2').matches.find(
        (match) => match.id === 'GF2',
      )?.away.entrantId,
    ).toBe('team2');
  });

  it('cross-seeds pool winners against runners-up', () => {
    const seeded = crossSeedPools(
      [
        { id: 'A1', seed: 1, pool: 'A', poolRank: 1 },
        { id: 'A2', seed: 2, pool: 'A', poolRank: 2 },
        { id: 'B1', seed: 3, pool: 'B', poolRank: 1 },
        { id: 'B2', seed: 4, pool: 'B', poolRank: 2 },
      ],
      'cross_pool',
    );
    const bracket = generateSingleElimination(seeded);
    expect(
      bracket.matches
        .filter((match) => match.round === 1)
        .map((match) => [match.home.entrantId, match.away.entrantId]),
    ).toEqual([
      ['A1', 'B2'],
      ['B1', 'A2'],
    ]);
  });
});
