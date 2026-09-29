import { describe, expect, it } from 'vitest';

import { roundRobinPoolPairings, seedFromPools } from './service';

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

  it('cross-seeds pool ranks and assigns consecutive bracket seeds', () => {
    const seeded = seedFromPools(
      [
        { id: 'b2', seed: 1, pool: 'B', poolRank: 2 },
        { id: 'a2', seed: 2, pool: 'A', poolRank: 2 },
        { id: 'b1', seed: 3, pool: 'B', poolRank: 1 },
        { id: 'a1', seed: 4, pool: 'A', poolRank: 1 },
      ],
      'cross_pool',
    );

    expect(seeded.map((entrant) => entrant.id)).toEqual([
      'a1',
      'b1',
      'a2',
      'b2',
    ]);
    expect(seeded.map((entrant) => entrant.seed)).toEqual([1, 2, 3, 4]);
  });

  it('rejects cross-pool seeding unless there are exactly two balanced pools', () => {
    expect(() =>
      seedFromPools(
        [
          { id: 'a1', seed: 1, pool: 'A', poolRank: 1 },
          { id: 'b1', seed: 2, pool: 'B', poolRank: 1 },
          { id: 'c1', seed: 3, pool: 'C', poolRank: 1 },
        ],
        'cross_pool',
      ),
    ).toThrow('Cross-pool seeding requires two pools');
  });
});
