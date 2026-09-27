import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../src/db/kysely';
import { createWithOrg } from '../src/db/withOrg';
import {
  assignMeetParticipants,
  contestDetail,
  createContest,
} from '../src/modules/contests/service';
import {
  archiveSeason,
  changeSeasonSurveyStatus,
  createSeasonSurvey,
  getSeasonSurveyResults,
  listFamilySeasonSurveys,
  submitSeasonSurveyResponse,
} from '../src/modules/standings/season-end';
import {
  advanceBracketMatch,
  getPublicBracketBySlug,
  setBracketContest,
} from '../src/modules/tournaments/service';
import {
  createBracket,
  createTournamentPool,
  generateBracket,
  getBracket,
} from '../src/modules/tournaments/service';

import type { ActorFixture } from './factories';
import { createTestFactories } from './factories';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for competition tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});
afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

async function actorWithManager(): Promise<ActorFixture> {
  const factory = createTestFactories(database);
  const actor = await factory.actor();
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .where('account_id', '=', actor.accountId)
      .execute();
  });
  return actor;
}

describe('tournament pools and season-end operations', () => {
  it('assigns unique heats and lanes for a timed individual meet', async () => {
    const factory = createTestFactories(database);
    const actor = await actorWithManager();
    const program = await factory.program(actor);
    const swimming = builtInSportTemplates.find(
      (profile) => profile.key === 'swimming',
    );
    if (!swimming) throw new Error('Swimming sport template is missing.');
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('sport_profiles')
        .set({ profile: swimming })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.sportProfileId)
        .execute();
    });
    const eventId = await factory.event(actor);
    const people = await Promise.all([
      factory.person(actor, { firstName: 'Lane', lastName: 'One' }),
      factory.person(actor, { firstName: 'Lane', lastName: 'Two' }),
    ]);
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('events')
        .set({ program_id: program.programId, division_id: program.divisionId })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', eventId)
        .execute();
      await trx
        .insertInto('event_participants')
        .values(
          people.map((personId) => ({
            id: newId(),
            org_id: actor.orgId,
            event_id: eventId,
            team_season_id: null,
            external_team_id: null,
            person_id: personId,
            division_id: null,
            side: 'none',
          })),
        )
        .execute();
    });
    const contest = await createContest(actor, eventId, {
      formatIndex: 0,
      stage: 'regular',
      countsForStandings: false,
    });
    expect(contest.format.format).toBe('multi_timed');
    const detail = await contestDetail(actor, contest.id);
    const assignments = detail.participants.map((participant, index) => ({
      participantId: participant.id,
      seed: index + 1,
      heat: 1,
      lane: index + 1,
    }));
    const updated = await assignMeetParticipants(actor, contest.id, {
      expectedVersion: contest.version,
      assignments,
    });
    expect(updated.version).toBe(contest.version + 1);
    const refreshed = await contestDetail(actor, contest.id);
    expect(
      refreshed.participants.map((participant) => [
        participant.seed,
        participant.heat,
        participant.lane,
      ]),
    ).toEqual([
      [1, 1, 1],
      [2, 1, 2],
    ]);
    await expect(
      assignMeetParticipants(actor, contest.id, {
        expectedVersion: updated.version,
        assignments: assignments.map((assignment) => ({
          ...assignment,
          lane: 1,
        })),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('seeds the elimination bracket from finalized pool standings', async () => {
    const factory = createTestFactories(database);
    const actor = await actorWithManager();
    const program = await factory.program(actor);
    const teams = await Promise.all([
      factory.team(actor, program),
      factory.team(actor, program),
      factory.team(actor, program),
      factory.team(actor, program),
    ]);
    const bracket = await createBracket(actor, {
      programId: program.programId,
      name: 'Pool to bracket',
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
    const poolMatches = (await getBracket(actor, bracket.id)).matches;
    expect(poolMatches).toHaveLength(2);

    for (const match of poolMatches) {
      const home = (match.participant_a as { entrantId: string }).entrantId;
      const away = (match.participant_b as { entrantId: string }).entrantId;
      const eventId = await factory.event(actor);
      const contestId = await factory.contest(
        actor,
        eventId,
        program.sportProfileId,
      );
      const homeParticipantId = newId();
      const awayParticipantId = newId();
      await createWithOrg(database)(actor, async (trx) => {
        await trx
          .insertInto('contest_participants')
          .values([
            {
              id: homeParticipantId,
              org_id: actor.orgId,
              contest_id: contestId,
              team_season_id: home,
              external_team_id: null,
              person_id: null,
              side: 'home',
            },
            {
              id: awayParticipantId,
              org_id: actor.orgId,
              contest_id: contestId,
              team_season_id: away,
              external_team_id: null,
              person_id: null,
              side: 'away',
            },
          ])
          .execute();
      });
      await setBracketContest(
        actor,
        bracket.id,
        match.id,
        contestId,
        match.version,
      );
      await createWithOrg(database)(actor, async (trx) => {
        await trx
          .updateTable('contests')
          .set({ status: 'final' })
          .where('org_id', '=', actor.orgId)
          .where('id', '=', contestId)
          .execute();
        await trx
          .insertInto('contest_results')
          .values([
            {
              id: newId(),
              org_id: actor.orgId,
              contest_participant_id: homeParticipantId,
              outcome: 'win',
              score: 2,
              score_detail: {},
            },
            {
              id: newId(),
              org_id: actor.orgId,
              contest_participant_id: awayParticipantId,
              outcome: 'loss',
              score: 1,
              score_detail: {},
            },
          ])
          .execute();
        await advanceBracketMatch(trx, actor.orgId, bracket.id, match.id, home);
      });
    }
    const generated = await getBracket(actor, bracket.id);
    expect(generated.matches).toHaveLength(5);
    const eliminationMatch = generated.matches.find(
      (match) =>
        !('poolId' in (match.participant_a as Record<string, unknown>)),
    );
    expect(eliminationMatch?.round).toBe(2);
    expect(eliminationMatch?.participant_a).toMatchObject({
      entrantId: teams[0].teamSeasonId,
    });
    expect(eliminationMatch?.participant_b).toMatchObject({
      entrantId: teams[3].teamSeasonId,
    });
    const organization = await database
      .selectFrom('organizations')
      .select('slug')
      .where('id', '=', actor.orgId)
      .executeTakeFirstOrThrow();
    const publicBracket = await getPublicBracketBySlug(
      organization.slug,
      bracket.id,
    );
    expect(publicBracket.entries[0]?.team_season_id).toBe(
      teams[0].teamSeasonId,
    );
    expect(publicBracket.entries[0]?.team_name).toBe('Fixture Team');
  });

  it('generates pool games, captures verified family feedback, and archives completed seasons', async () => {
    const factory = createTestFactories(database);
    const actor = await actorWithManager();
    const foreignActor = await actorWithManager();
    const program = await factory.program(actor);

    const teams = await Promise.all([
      factory.team(actor, program),
      factory.team(actor, program),
      factory.team(actor, program),
      factory.team(actor, program),
    ]);
    const bracket = await createBracket(actor, {
      programId: program.programId,
      name: 'Pool tournament',
      type: 'round_robin_pools',
      seedingSource: 'manual',
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
    await expect(
      generateBracket(actor, bracket.id, bracket.version),
    ).resolves.toMatchObject({ matches: 2, size: 4, automaticByes: 0 });
    const generated = await getBracket(actor, bracket.id);
    expect(generated.bracket.status).toBe('published');
    expect(generated.matches).toHaveLength(2);
    expect(
      generated.matches.map(
        (match) => (match.participant_a as { poolName?: string }).poolName,
      ),
    ).toEqual(['Pool A', 'Pool B']);

    const personId = await factory.person(actor);
    const householdId = await factory.household(actor);
    await factory.registration(actor, program, personId, householdId);
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: actor.orgId,
          household_id: householdId,
          person_id: personId,
          role: 'guardian',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: actor.orgId,
          person_id: personId,
          account_id: actor.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
    });
    const survey = await createSeasonSurvey(actor, program.programId, {
      title: 'Season feedback',
      locale: 'es',
    });
    await changeSeasonSurveyStatus(actor, survey.id, survey.version, 'open');
    await expect(listFamilySeasonSurveys(actor)).resolves.toEqual([
      expect.objectContaining({ id: survey.id, locale: 'es' }),
    ]);
    await expect(
      submitSeasonSurveyResponse(actor, survey.id, {
        nps: 10,
        responseText: 'Great season',
      }),
    ).resolves.toMatchObject({ campaign_id: survey.id });
    await expect(
      getSeasonSurveyResults(actor, survey.id),
    ).resolves.toMatchObject({ responseCount: 1, nps: 100 });
    await expect(
      getSeasonSurveyResults(foreignActor, survey.id),
    ).rejects.toThrow(/not found/i);
    await expect(
      submitSeasonSurveyResponse(actor, survey.id, { nps: 8 }),
    ).rejects.toThrow();

    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ status: 'completed' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('seasons')
        .set({ status: 'completed' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.seasonId)
        .execute();
    });
    await expect(
      archiveSeason(actor, program.seasonId, 1),
    ).resolves.toMatchObject({ status: 'archived', version: 2 });
  });
});
