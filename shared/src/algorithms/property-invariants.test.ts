import { Temporal } from '@js-temporal/polyfill';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { nextPowerOfTwo, seedPositions } from './brackets.js';
import { changeCapacity } from './capacity-math.js';
import { nextInstallmentAttempt } from './dunning-schedule.js';
import { scoreEvaluations } from './evaluation.js';
import { circlePairings } from './schedule-generator.js';
import { nextWaitlistOffer } from './waitlist.js';

describe('algorithm properties', () => {
  it('seeds every valid bracket size exactly once', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 1024 }), (count) => {
        const size = nextPowerOfTwo(count);
        expect(size).toBeGreaterThanOrEqual(count);
        expect(size & (size - 1)).toBe(0);
        expect(new Set(seedPositions(size))).toEqual(
          new Set(Array.from({ length: size }, (_, index) => index + 1)),
        );
      }),
    );
  });

  it('releases any valid capacity hold back to its original counters', () => {
    fc.assert(
      fc.property(fc.nat(1000), fc.nat(1000), (confirmed, held) => {
        const initial = [
          {
            subject: 'program' as const,
            id: 'p',
            capacity: confirmed + held + 1,
            confirmed,
            held,
          },
        ];
        expect(
          changeCapacity(changeCapacity(initial, 'hold'), 'release'),
        ).toEqual(initial);
      }),
    );
  });

  it('gives every pair one round-robin game, including odd team counts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), (count) => {
        const ids = Array.from(
          { length: count },
          (_, index) => `t${String(index)}`,
        );
        const games = circlePairings({
          id: 'd',
          teamIds: ids,
          allowedWeekdays: [1],
          timeWindows: [{ start: '08:00', end: '20:00' }],
        });
        const pairs = games.map((game) =>
          [game.homeTeamId, game.awayTeamId].sort().join(':'),
        );
        expect(new Set(pairs).size).toBe((count * (count - 1)) / 2);
        expect(games).toHaveLength((count * (count - 1)) / 2);
      }),
    );
  });

  it('schedules retry attempts strictly after failure', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), (attempt) => {
        const failedAt = '2026-03-07T23:00:00Z';
        const next = nextInstallmentAttempt(
          failedAt,
          attempt,
          'insufficient_funds',
          'America/Chicago',
        );
        expect(next.retry).toBe(true);
        expect(
          Temporal.Instant.compare(
            Temporal.Instant.from(next.nextAttemptAt ?? ''),
            Temporal.Instant.from(failedAt),
          ),
        ).toBeGreaterThan(0);
      }),
    );
  });

  it('selects the same earliest waitlist entry regardless of input order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 100 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (positions) => {
          const entries = positions.map((position) => ({
            id: String(position),
            offeringId: 'o',
            programId: 'p',
            personId: String(position),
            joinedAt: '2026-09-01T00:00:00Z',
            position,
            status: 'waiting' as const,
            timezone: 'UTC',
          }));
          const input = {
            entries,
            offeringId: 'o',
            capacity: null,
            confirmed: 0,
            held: 0,
            mode: 'auto' as const,
            now: '2026-09-01T15:00:00Z',
          };
          expect(nextWaitlistOffer(input)?.entryId).toBe(
            nextWaitlistOffer({ ...input, entries: [...entries].reverse() })
              ?.entryId,
          );
        },
      ),
    );
  });

  it('preserves evaluation scores when athlete order changes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (a, b) => {
          const athletes = [
            { id: 'a', name: 'A', group: 'g', positions: [] },
            { id: 'b', name: 'B', group: 'g', positions: [] },
          ];
          const input = {
            athletes,
            criteria: [{ key: 'skill', weight: 1, scaleMin: 1, scaleMax: 10 }],
            scores: [
              {
                athleteId: 'a',
                evaluatorId: 'e',
                criterionKey: 'skill',
                score: a,
              },
              {
                athleteId: 'b',
                evaluatorId: 'e',
                criterionKey: 'skill',
                score: b,
              },
            ],
            normalization: 'none' as const,
          };
          const first = scoreEvaluations(input);
          const reversed = scoreEvaluations({
            ...input,
            athletes: [...athletes].reverse(),
          });
          for (const result of first)
            expect(
              reversed.find((item) => item.athleteId === result.athleteId)
                ?.composite,
            ).toBe(result.composite);
        },
      ),
    );
  });
});
