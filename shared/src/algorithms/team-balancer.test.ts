import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { balanceTeams, type BalanceInput } from './team-balancer.js';

const input: BalanceInput = {
  players: [
    { id: 'a', rating: 9, positions: ['gk'], fixedTeamId: 'red' },
    { id: 'b', rating: 8, positions: ['gk'], fixedTeamId: 'blue' },
    { id: 'c', rating: 7, positions: ['field'], friendRequestId: 'd' },
    { id: 'd', rating: 6, positions: ['field'], friendRequestId: 'c' },
    { id: 'e', rating: 5, positions: ['field'], siblingGroupId: 'family' },
    { id: 'f', rating: 4, positions: ['field'], siblingGroupId: 'family' },
  ],
  teams: [
    { id: 'red', maxRoster: 3, minPositions: { gk: 1 } },
    { id: 'blue', maxRoster: 3, minPositions: { gk: 1 } },
  ],
  siblingsTogether: true,
  returningStay: false,
  seed: 42,
  timeBudgetSeconds: 0.2,
};

describe('team balancer', () => {
  it('keeps fixed placements, mutual friends and siblings together', () => {
    const result = balanceTeams(input);
    expect(result.assignments.a).toBe('red');
    expect(result.assignments.b).toBe('blue');
    expect(result.assignments.c).toBe(result.assignments.d);
    expect(result.assignments.e).toBe(result.assignments.f);
    expect(
      result.metrics.every(
        (metric) =>
          metric.size === 3 && metric.positionCoverageViolations === 0,
      ),
    ).toBe(true);
  });

  it('is deterministic for a seed', () => {
    expect(balanceTeams(input)).toEqual(balanceTeams(input));
    expect(balanceTeams(input).metrics[0]).not.toHaveProperty('meanAge');
  });

  it('balances team mean age while preserving the rating objective', () => {
    const players = Array.from({ length: 8 }, (_, index) => ({
      id: `age-${String(index)}`,
      rating: 5,
      age: index < 4 ? 8 : 10,
      positions: [],
    }));
    const result = balanceTeams({
      ...input,
      players,
      teams: [
        { id: 'red', maxRoster: 4 },
        { id: 'blue', maxRoster: 4 },
      ],
      siblingsTogether: false,
      returningStay: false,
      seed: 7,
      timeBudgetSeconds: 1,
    });
    expect(result.metrics.map((metric) => metric.meanAge)).toEqual([9, 9]);
    expect(result.metrics.every((metric) => metric.meanRating === 5)).toBe(
      true,
    );
  });

  it('rejects conflicting fixed assignments inside a linked group', () => {
    const players = [
      { id: 'x', positions: [], siblingGroupId: 's', fixedTeamId: 'red' },
      { id: 'y', positions: [], siblingGroupId: 's', fixedTeamId: 'blue' },
    ];
    expect(() => balanceTeams({ ...input, players })).toThrow();
  });

  it('assigns every player exactly once within roster capacities', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 16 }), (count) => {
        const players = Array.from({ length: count }, (_, index) => ({
          id: String(index),
          rating: index,
          positions: ['field'],
        }));
        const output = balanceTeams({
          ...input,
          players,
          teams: [
            { id: 'red', maxRoster: count },
            { id: 'blue', maxRoster: count },
          ],
          siblingsTogether: false,
          timeBudgetSeconds: 0,
        });
        expect(Object.keys(output.assignments)).toHaveLength(count);
        expect(output.metrics.every((metric) => metric.size <= count)).toBe(
          true,
        );
      }),
    );
  });

  it('balances 120 players across 10 teams within 3% mean rating in under five seconds', () => {
    const players = Array.from({ length: 120 }, (_, index) => {
      const player: BalanceInput['players'][number] = {
        id: `p${String(index)}`,
        rating: 20 + ((index * 37) % 80),
        age: 8 + (index % 4),
        positions:
          index % 12 === 0
            ? ['keeper']
            : index % 3 === 0
              ? ['defense']
              : ['field'],
      };
      if (index < 10) player.fixedTeamId = `t${String(index)}`;
      else if (index < 20 && index % 2 === 0)
        player.friendRequestId = `p${String(index + 1)}`;
      else if (index < 20) player.friendRequestId = `p${String(index - 1)}`;
      else if (index < 40) player.siblingGroupId = `fam${String(index % 10)}`;
      return player;
    });
    const teams = Array.from({ length: 10 }, (_, index) => ({
      id: `t${String(index)}`,
      maxRoster: 12,
      minPositions: { keeper: 1 },
    }));
    const started = Date.now();
    const output = balanceTeams({
      players,
      teams,
      siblingsTogether: true,
      returningStay: false,
      seed: 2024,
      timeBudgetSeconds: 5,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(Object.keys(output.assignments)).toHaveLength(120);
    expect(output.metrics.every((metric) => metric.size <= 12)).toBe(true);
    expect(
      output.metrics.every((metric) => metric.positionCoverageViolations === 0),
    ).toBe(true);
    for (let index = 0; index < 10; index += 1)
      expect(output.assignments[`p${String(index)}`]).toBe(`t${String(index)}`);
    const globalMean =
      output.metrics.reduce((sum, metric) => sum + metric.totalRating, 0) / 120;
    for (const metric of output.metrics)
      expect(metric.meanRating).toBeGreaterThanOrEqual(globalMean * 0.97);
    for (const metric of output.metrics)
      expect(metric.meanRating).toBeLessThanOrEqual(globalMean * 1.03);
    expect(output.metrics.every((metric) => metric.meanAge !== undefined)).toBe(
      true,
    );
    const teamAges = output.metrics.map((metric) => metric.meanAge ?? 0);
    expect(Math.max(...teamAges) - Math.min(...teamAges)).toBeLessThanOrEqual(
      1,
    );
    expect(
      balanceTeams({
        players,
        teams,
        siblingsTogether: true,
        returningStay: false,
        seed: 2024,
        timeBudgetSeconds: 5,
      }).assignments,
    ).toEqual(output.assignments);
  });
});
