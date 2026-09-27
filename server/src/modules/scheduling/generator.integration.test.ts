import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { startRegisteredWorker } from '../jobs/runtime';
import {
  createBracket,
  createTournamentPool,
  generateBracket,
  getBracket,
} from '../tournaments/service';

import {
  applyGenerationRun,
  createGenerationRun,
  getGenerationRun,
  stopSchedulingQueue,
} from './generator';
import { moduleDefinition as schedulingModule } from './module';

let database: ReturnType<typeof createDatabase>;
let stopWorker: (() => Promise<void>) | undefined;
type TestActor = OrgContext & { accountId: string };

beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for schedule tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
  const worker = await startRegisteredWorker(
    [schedulingModule],
    connectionString,
  );
  stopWorker = worker.stop;
});

afterAll(async () => {
  await stopWorker?.();
  await stopSchedulingQueue();
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

async function actorWithManager(): Promise<TestActor> {
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `schedule-${accountId}@example.invalid`,
      first_name: 'Schedule',
      last_name: 'Manager',
      date_of_birth: '1990-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `schedule-${orgId.slice(0, 8)}`,
      name: 'Schedule Test Org',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  const actor: TestActor = {
    orgId,
    accountId,
    actor: { accountId },
  };
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        status: 'active',
        joined_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('role_assignments')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        role: 'owner',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
  });
  return actor;
}

async function createProgram(actor: TestActor) {
  const seasonId = newId();
  const sportProfileId = newId();
  const programId = newId();
  const divisionId = newId();
  const offeringId = newId();
  const template = builtInSportTemplates[0];
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .insertInto('seasons')
      .values({
        id: seasonId,
        org_id: actor.orgId,
        name: 'Schedule Test Season',
        starts_on: '2026-01-01',
        ends_on: '2026-12-31',
      })
      .execute();
    await trx
      .insertInto('sport_profiles')
      .values({
        id: sportProfileId,
        org_id: actor.orgId,
        name: 'Soccer',
        profile: template,
      })
      .execute();
    await trx
      .insertInto('programs')
      .values({
        id: programId,
        org_id: actor.orgId,
        season_id: seasonId,
        sport_profile_id: sportProfileId,
        mode: 'league',
        name: 'Tournament Program',
        slug: `schedule-${programId.slice(0, 8)}`,
        starts_on: '2026-03-01',
        ends_on: '2026-11-30',
      })
      .execute();
    await trx
      .insertInto('divisions')
      .values({
        id: divisionId,
        org_id: actor.orgId,
        program_id: programId,
        name: 'Open',
        level: 'open',
      })
      .execute();
    await trx
      .insertInto('registration_offerings')
      .values({
        id: offeringId,
        org_id: actor.orgId,
        program_id: programId,
        division_id: divisionId,
        name: 'Player',
        registrant_role: 'athlete',
        price_cents: 0,
      })
      .execute();
  });
  return { sportProfileId, programId, divisionId };
}

async function createTeam(
  actor: TestActor,
  program: Awaited<ReturnType<typeof createProgram>>,
) {
  const teamId = newId();
  const teamSeasonId = newId();
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .insertInto('teams')
      .values({
        id: teamId,
        org_id: actor.orgId,
        name: `Schedule Team ${teamSeasonId.slice(0, 6)}`,
        sport_profile_id: program.sportProfileId,
      })
      .execute();
    await trx
      .insertInto('team_seasons')
      .values({
        id: teamSeasonId,
        org_id: actor.orgId,
        team_id: teamId,
        program_id: program.programId,
        division_id: program.divisionId,
      })
      .execute();
  });
  return { teamSeasonId };
}

describe('tournament schedule generator', () => {
  it('generates pool games, reserves bracket rounds, and binds pool events', async () => {
    const actor = await actorWithManager();
    const program = await createProgram(actor);
    const teams = await Promise.all([
      createTeam(actor, program),
      createTeam(actor, program),
      createTeam(actor, program),
      createTeam(actor, program),
    ]);
    const bracket = await createBracket(actor, {
      programId: program.programId,
      name: 'October pool tournament',
      type: 'pools_to_bracket',
      seedingSource: 'pool_results',
      entries: teams.map((team, index) => ({
        teamSeasonId: team.teamSeasonId,
        seed: index + 1,
      })),
    });
    await createTournamentPool(actor, bracket.id, 'Pool A', [
      { teamSeasonId: teams[0].teamSeasonId },
      { teamSeasonId: teams[1].teamSeasonId },
    ]);
    await createTournamentPool(actor, bracket.id, 'Pool B', [
      { teamSeasonId: teams[2].teamSeasonId },
      { teamSeasonId: teams[3].teamSeasonId },
    ]);
    await generateBracket(actor, bracket.id, bracket.version);

    const facilityId = newId();
    const spaceId = newId();
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .insertInto('facilities')
        .values({
          id: facilityId,
          org_id: actor.orgId,
          name: 'Tournament Field',
          ownership: 'owned',
          timezone: 'America/Chicago',
        })
        .execute();
      await trx
        .insertInto('spaces')
        .values({
          id: spaceId,
          org_id: actor.orgId,
          facility_id: facilityId,
          name: 'Field 1',
          kind: 'field',
          suitability: { sportProfileIds: [program.sportProfileId] },
        })
        .execute();
      await trx
        .insertInto('space_availability')
        .values({
          id: newId(),
          org_id: actor.orgId,
          space_id: spaceId,
          recurrence: {
            kind: 'weekly',
            interval: 1,
            byDay: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'],
            startsOn: '2026-10-01',
            endsOn: '2026-11-01',
          },
          starts_on: '2026-10-01',
          ends_on: '2026-11-01',
          start_time: '08:00',
          end_time: '18:00',
          source: 'owned',
        })
        .execute();
    });

    const runId = await createGenerationRun(actor, program.programId, {
      seed: 17,
      seasonStartsOn: '2026-10-01',
      seasonEndsOn: '2026-11-01',
      tournament: {
        bracketId: bracket.id,
        poolDays: ['2026-10-03', '2026-10-04'],
        poolTimeWindow: { start: '08:00', end: '18:00' },
      },
      maxGamesPerTeamPerDay: 1,
      minRestHours: 18,
      timeBudgetSeconds: 2,
    });
    let completed = await getGenerationRun(actor, runId);
    const deadline = Date.now() + 10_000;
    while (completed.status === 'queued' || completed.status === 'running') {
      if (Date.now() >= deadline)
        throw new Error('Schedule generation worker did not finish in time.');
      await new Promise((resolve) => setTimeout(resolve, 50));
      completed = await getGenerationRun(actor, runId);
    }
    expect(completed.status).toBe('succeeded');
    expect(
      (completed.result as { draftEvents: unknown[] }).draftEvents,
    ).toHaveLength(2);
    expect(
      (completed.result as { bracketReservations: unknown[] })
        .bracketReservations,
    ).toHaveLength(3);

    const applied = await applyGenerationRun(actor, runId, completed.version);
    expect(applied.eventIds).toHaveLength(5);
    expect(applied.bracketReservationEventIds).toHaveLength(3);
    expect(applied.eventIds.slice(2)).toEqual(
      applied.bracketReservationEventIds,
    );
    const currentBracket = await getBracket(actor, bracket.id);
    expect(currentBracket.reservations).toHaveLength(5);
    expect(
      currentBracket.reservations.filter(
        (reservation) => reservation.slot_type === 'pool',
      ),
    ).toHaveLength(2);

    const poolEvent = await createWithOrg(database)(actor, async (trx) =>
      trx
        .selectFrom('tournament_schedule_reservations')
        .select('event_id')
        .where('org_id', '=', actor.orgId)
        .where('bracket_id', '=', bracket.id)
        .where('slot_type', '=', 'pool')
        .executeTakeFirstOrThrow(),
    );
    const contest = await import('../contests/service').then((service) =>
      service.createContest(actor, poolEvent.event_id, {
        formatIndex: 0,
        stage: 'regular',
        countsForStandings: false,
      }),
    );
    const linkedBracket = await getBracket(actor, bracket.id);
    const linkedMatch = linkedBracket.matches.find(
      (match) => match.contest_id === contest.id,
    );
    expect(linkedMatch).toBeDefined();
  });
});
