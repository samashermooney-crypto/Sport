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
});
