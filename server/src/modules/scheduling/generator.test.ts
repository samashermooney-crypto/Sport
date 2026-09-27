import { generateSchedule } from '@shared/algorithms/schedule-generator';
import type { GeneratorInput } from '@shared/algorithms/schedule-generator';
import { describe, expect, it } from 'vitest';

const saturdayWindows = Array.from({ length: 10 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 3, 4 + index * 7));
  const localDate = date.toISOString().slice(0, 10);
  return [
    {
      startsAt: `${localDate}T13:00:00.000Z`,
      endsAt: `${localDate}T14:15:00.000Z`,
    },
    {
      startsAt: `${localDate}T14:15:00.000Z`,
      endsAt: `${localDate}T15:30:00.000Z`,
    },
    {
      startsAt: `${localDate}T15:30:00.000Z`,
      endsAt: `${localDate}T16:45:00.000Z`,
    },
  ];
}).flat();

function recLeagueInput(): GeneratorInput {
  const divisions = Array.from({ length: 6 }, (_, divisionIndex) => {
    const id = `division-${String(divisionIndex + 1)}`;
    return {
      id,
      teamIds: Array.from(
        { length: 8 },
        (_, teamIndex) => `team-${String(divisionIndex * 8 + teamIndex + 1)}`,
      ),
      roundRobin: 'once' as const,
      allowedWeekdays: [6],
      timeWindows: [{ start: '08:00', end: '12:00' }],
      ageOrder: divisionIndex + 8,
    };
  });
  const teams = divisions.flatMap((division) =>
    division.teamIds.map((id, index) => ({
      id,
      coachIds: [`coach-${String(index)}`],
      blackoutDates: [],
    })),
  );
  const spaces = Array.from({ length: 8 }, (_, index) => ({
    id: `field-${String(index + 1)}`,
    facilityId: 'north-park',
    suitableDivisionIds: divisions.map((division) => division.id),
    availability: saturdayWindows,
  }));
  return {
    divisions,
    teams,
    spaces,
    seasonStartsOn: '2026-04-04',
    seasonEndsOn: '2026-06-06',
    timezone: 'America/Chicago',
    durationMinutes: 60,
    bufferMinutes: 15,
    maxGamesPerTeamPerDay: 1,
    maxGamesPerTeamPerWeek: 1,
    minRestHours: 12,
    seed: 20260404,
    timeBudgetSeconds: 0.5,
  };
}

describe('schedule generator league acceptance', () => {
  it('places or explains every game for six divisions and 48 teams without hard conflicts', () => {
    const input = recLeagueInput();
    const startedAt = performance.now();
    const output = generateSchedule(input);
    expect(performance.now() - startedAt).toBeLessThan(60_000);
    expect(output.draftEvents.length + output.unscheduled.length).toBe(168);
    expect(output.unscheduled.every((game) => game.reasons.length > 0)).toBe(
      true,
    );
    expect(
      output.teamMetrics.every((team) => Math.abs(team.home - team.away) <= 1),
    ).toBe(true);

    const teamById = new Map(input.teams.map((team) => [team.id, team]));
    const dayByTeam = new Map<string, Set<string>>();
    const gamesByCoach = new Map<string, typeof output.draftEvents>();
    for (const game of output.draftEvents) {
      const day = game.localDate;
      for (const teamId of [game.homeTeamId, game.awayTeamId]) {
        const days = dayByTeam.get(teamId) ?? new Set<string>();
        expect(days.has(day)).toBe(false);
        days.add(day);
        dayByTeam.set(teamId, days);
        for (const coachId of teamById.get(teamId)?.coachIds ?? []) {
          const games = gamesByCoach.get(coachId) ?? [];
          games.push(game);
          gamesByCoach.set(coachId, games);
        }
      }
    }
    for (const games of gamesByCoach.values()) {
      const sorted = [...games].sort((a, b) =>
        a.startsAt.localeCompare(b.startsAt),
      );
      for (let index = 1; index < sorted.length; index += 1) {
        const prior = sorted[index - 1];
        const current = sorted[index];
        if (!prior || !current) continue;
        expect(new Date(prior.endsAt).getTime()).toBeLessThanOrEqual(
          new Date(current.startsAt).getTime(),
        );
      }
    }
  }, 65_000);
});
