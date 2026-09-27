import {
  finalizeBracketMatch,
  generateDoubleElimination,
} from '@shared/algorithms/brackets';
import type { Bracket, BracketMatch } from '@shared/algorithms/brackets';
import { describe, expect, it } from 'vitest';

function playDoubleElimination(bracket: Bracket): Bracket {
  const seedByEntrant = new Map(
    Array.from({ length: 13 }, (_, index) => [
      `team-${String(index + 1)}`,
      index + 1,
    ]),
  );
  let current = bracket;
  for (let pass = 0; pass < 64; pass += 1) {
    let advanced = false;
    for (const match of current.matches) {
      if (match.finalized || !match.home.entrantId || !match.away.entrantId)
        continue;
      const winner = winnerFor(match, seedByEntrant);
      current = finalizeBracketMatch(current, match.id, winner);
      advanced = true;
    }
    if (!advanced) break;
  }
  return current;
}

function winnerFor(
  match: BracketMatch,
  seedByEntrant: ReadonlyMap<string, number>,
): string {
  const home = match.home.entrantId;
  const away = match.away.entrantId;
  if (!home || !away) throw new Error('Match must have both entrants');
  if (match.id === 'GF1') return away;
  if (match.id === 'GF2') return home;
  return (seedByEntrant.get(home) ?? Number.MAX_SAFE_INTEGER) <
    (seedByEntrant.get(away) ?? Number.MAX_SAFE_INTEGER)
    ? home
    : away;
}

describe('13-team double-elimination acceptance', () => {
  it('advances bye winners and losers through the if-necessary final', () => {
    const entrants = Array.from({ length: 13 }, (_, index) => ({
      id: `team-${String(index + 1)}`,
      seed: index + 1,
    }));
    const generated = generateDoubleElimination(entrants);
    expect(generated.size).toBe(16);
    expect(generated.resetFinalId).toBe('GF2');
    expect(
      generated.matches.filter(
        (match) =>
          match.bracket === 'winners' && match.round === 1 && match.finalized,
      ),
    ).toHaveLength(3);

    const completed = playDoubleElimination(generated);
    const firstFinal = completed.matches.find((match) => match.id === 'GF1');
    expect(firstFinal?.finalized).toBe(true);
    expect(firstFinal?.winnerId).toBe(firstFinal?.away.entrantId);
    expect(completed.matches.find((match) => match.id === 'GF2')).toMatchObject(
      {
        home: { entrantId: firstFinal?.home.entrantId },
        away: { entrantId: firstFinal?.away.entrantId },
      },
    );
    const resetWinner = completed.matches.find(
      (match) => match.id === 'GF2',
    )?.winnerId;
    expect(resetWinner).toBe(firstFinal?.home.entrantId);
  });
});
