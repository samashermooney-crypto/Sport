import { describe, expect, it } from 'vitest';

import {
  circlePairings,
  generateSchedule,
  generateTournamentSchedule,
  type GeneratorInput,
} from './schedule-generator.js';

const input: GeneratorInput = {
  divisions: [
    {
      id: 'u12',
      teamIds: ['a', 'b', 'c'],
      roundRobin: 'once',
      allowedWeekdays: [6],
      timeWindows: [{ start: '08:00', end: '14:00' }],
      ageOrder: 12,
      preferredStartMinutes: 9 * 60,
    },
  ],
  teams: [
    { id: 'a', coachIds: ['coachA'], blackoutDates: [] },
    { id: 'b', coachIds: ['coachB'], blackoutDates: [] },
    { id: 'c', coachIds: ['coachC'], blackoutDates: [] },
  ],
  spaces: [
    {
      id: 'field1',
      facilityId: 'park',
      suitableDivisionIds: ['u12'],
      availability: [
        { startsAt: '2026-09-05T13:00:00Z', endsAt: '2026-09-05T19:00:00Z' },
        { startsAt: '2026-09-12T13:00:00Z', endsAt: '2026-09-12T19:00:00Z' },
        { startsAt: '2026-09-19T13:00:00Z', endsAt: '2026-09-19T19:00:00Z' },
      ],
    },
  ],
  seasonStartsOn: '2026-09-01',
  seasonEndsOn: '2026-09-30',
  timezone: 'America/Chicago',
  durationMinutes: 60,
  bufferMinutes: 15,
  maxGamesPerTeamPerDay: 1,
  maxGamesPerTeamPerWeek: 1,
  minRestHours: 2,
  seed: 42,
  timeBudgetSeconds: 0,
};

describe('schedule generator', () => {
  it('uses circle pairings and gives an odd team a bye each round', () => {
    const pairings = circlePairings(
      input.divisions[0] ?? {
        id: 'x',
        teamIds: [],
        allowedWeekdays: [],
        timeWindows: [],
      },
    );
    expect(pairings).toHaveLength(3);
    expect(
      new Set(pairings.flatMap((game) => [game.homeTeamId, game.awayTeamId])),
    ).toEqual(new Set(['a', 'b', 'c']));
    expect(new Set(pairings.map((game) => game.round)).size).toBe(3);
  });

  it('assigns each game within space windows without double-booking teams', () => {
    const output = generateSchedule(input);
    expect(output.draftEvents).toHaveLength(3);
    expect(output.unscheduled).toHaveLength(0);
    expect(
      output.teamMetrics.every((team) => team.home + team.away === 2),
    ).toBe(true);
    expect(
      new Set(output.draftEvents.map((event) => event.localDate)).size,
    ).toBe(3);
  });

  it('reports unscheduled games when space is blacked out', () => {
    const onlySpace = input.spaces[0];
    if (!onlySpace) throw new Error('Test space missing');
    const output = generateSchedule({
      ...input,
      spaces: [
        {
          ...onlySpace,
          blackouts: [
            {
              startsAt: '2026-09-05T13:00:00Z',
              endsAt: '2026-09-20T00:00:00Z',
            },
          ],
        },
      ],
    });
    expect(output.draftEvents).toHaveLength(0);
    expect(output.unscheduled).toHaveLength(3);
    expect(output.unscheduled[0]?.reasons[0]).toContain('No suitable space');
  });

  it('is deterministic for a seed, including local search', () => {
    const run = { ...input, timeBudgetSeconds: 0.1 };
    expect(generateSchedule(run)).toEqual(generateSchedule(run));
  });

  it('keeps one coach from overlapping games across facilities', () => {
    const twoDivisions: GeneratorInput = {
      ...input,
      divisions: [
        {
          id: 'first',
          teamIds: ['a', 'b'],
          allowedWeekdays: [6],
          timeWindows: [{ start: '08:00', end: '10:00' }],
        },
        {
          id: 'second',
          teamIds: ['c', 'd'],
          allowedWeekdays: [6],
          timeWindows: [{ start: '08:00', end: '10:00' }],
        },
      ],
      teams: [
        { id: 'a', coachIds: ['shared'], blackoutDates: [] },
        { id: 'b', coachIds: [], blackoutDates: [] },
        { id: 'c', coachIds: ['shared'], blackoutDates: [] },
        { id: 'd', coachIds: [], blackoutDates: [] },
      ],
      spaces: [
        {
          id: 'one',
          facilityId: 'north',
          suitableDivisionIds: ['first'],
          availability: [
            {
              startsAt: '2026-09-05T13:00:00Z',
              endsAt: '2026-09-05T15:00:00Z',
            },
          ],
        },
        {
          id: 'two',
          facilityId: 'south',
          suitableDivisionIds: ['second'],
          availability: [
            {
              startsAt: '2026-09-05T13:00:00Z',
              endsAt: '2026-09-05T15:00:00Z',
            },
          ],
        },
      ],
    };
    expect(generateSchedule(twoDivisions).unscheduled).toHaveLength(1);
  });

  it('honors parent and child space conflicts', () => {
    const field = input.spaces[0];
    if (!field) throw new Error('Test space missing');
    const output = generateSchedule({
      ...input,
      spaces: [
        { ...field, conflictSpaceIds: ['field2'] },
        {
          ...field,
          id: 'field2',
          conflictSpaceIds: ['field1'],
          bookings: [
            {
              startsAt: '2026-09-05T13:00:00Z',
              endsAt: '2026-09-05T19:00:00Z',
            },
          ],
        },
      ],
    });
    expect(
      output.draftEvents.every((event) => event.localDate !== '2026-09-05'),
    ).toBe(true);
  });

  it('places pool games first and reserves later bracket rounds with placeholders', () => {
    const tournament = generateTournamentSchedule(
      { ...input, minRestHours: 1 },
      ['2026-09-05'],
      [2, 1],
    );
    expect(
      tournament.draftEvents.every((event) => event.localDate === '2026-09-05'),
    ).toBe(true);
    expect(tournament.bracketReservations).toHaveLength(3);
    expect(tournament.bracketReservations[2]?.homePlaceholder).toContain(
      'Winner of B1-1',
    );
    expect(tournament.unscheduledBracketSlots).toHaveLength(0);
  });
});
