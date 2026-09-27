import { describe, expect, it } from 'vitest';

import { roundRobinPoolPairings } from './service';

describe('roundRobinPoolPairings', () => {
  it('uses the shared circle algorithm and keeps pools separate', () => {
    const matches = roundRobinPoolPairings([
      {
        id: 'pool-a',
        members: [
          { id: 'a1', teamSeasonId: 'team-a1', externalTeamId: null },
          { id: 'a2', teamSeasonId: 'team-a2', externalTeamId: null },
          { id: 'a3', teamSeasonId: 'team-a3', externalTeamId: null },
          { id: 'a4', teamSeasonId: 'team-a4', externalTeamId: null },
        ],
      },
      {
        id: 'pool-b',
        members: [
          { id: 'b1', teamSeasonId: null, externalTeamId: 'team-b1' },
          { id: 'b2', teamSeasonId: null, externalTeamId: 'team-b2' },
        ],
      },
    ]);

    expect(matches).toHaveLength(7);
    expect(matches.filter((match) => match.poolId === 'pool-a')).toHaveLength(
      6,
    );
    expect(matches.filter((match) => match.poolId === 'pool-b')).toHaveLength(
      1,
    );
    expect(
      matches.filter((match) => match.poolId === 'pool-a' && match.round === 1),
    ).toHaveLength(2);
    expect(
      matches.filter((match) => match.poolId === 'pool-b' && match.round === 1),
    ).toHaveLength(1);
    expect(
      new Set(
        matches.map(
          (match) => `${String(match.round)}:${String(match.position)}`,
        ),
      ).size,
    ).toBe(matches.length);
    expect(
      matches.every((match) => match.homeTeamId !== match.awayTeamId),
    ).toBe(true);
  });

  it('rejects a duplicate entrant within one pool', () => {
    expect(() =>
      roundRobinPoolPairings([
        {
          id: 'pool-a',
          members: [
            { id: 'a1', teamSeasonId: 'team-a', externalTeamId: null },
            { id: 'a2', teamSeasonId: 'team-a', externalTeamId: null },
          ],
        },
      ]),
    ).toThrow(/duplicate team/i);
  });
});
