import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import {
  archiveSeason,
  changeSeasonSurveyStatus,
  createSeasonAward,
  createSeasonSurvey,
  getPriorSeasonPlayerRatings,
  getSeasonSurveyResults,
  listFamilySeasonSurveys,
  listSeasonAwards,
  listSeasonSurveys,
  saveCoachPlayerRating,
  submitSeasonSurveyResponse,
} from './season-end';

let database: ReturnType<typeof createDatabase>;

type ActorFixture = OrgContext & { accountId: string };
type ProgramFixture = {
  seasonId: string;
  sportProfileId: string;
  programId: string;
  divisionId: string;
  offeringId: string;
};

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for season-end tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});

afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

async function actorWithManager(): Promise<ActorFixture> {
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `season-end-${accountId}@example.invalid`,
      first_name: 'Season',
      last_name: 'Manager',
      date_of_birth: '1990-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `season-end-${randomUUID().slice(0, 12)}`,
      name: 'Season End Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  const actor: ActorFixture = { orgId, accountId, actor: { accountId } };
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

async function createProgram(actor: ActorFixture): Promise<ProgramFixture> {
  const seasonId = newId();
  const sportProfileId = newId();
  const programId = newId();
  const divisionId = newId();
  const offeringId = newId();
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .insertInto('seasons')
      .values({
        id: seasonId,
        org_id: actor.orgId,
        name: 'Season End Test Season',
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
        profile: builtInSportTemplates[0],
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
        name: 'Season End Program',
        slug: `season-${programId.slice(0, 8)}`,
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
  return { seasonId, sportProfileId, programId, divisionId, offeringId };
}

async function createPerson(
  actor: ActorFixture,
  overrides: { firstName?: string; lastName?: string } = {},
): Promise<string> {
  const id = newId();
  await createWithOrg(database)(actor, (trx) =>
    trx
      .insertInto('people')
      .values({
        id,
        org_id: actor.orgId,
        first_name: overrides.firstName ?? 'Alex',
        last_name: overrides.lastName ?? 'Athlete',
        date_of_birth: '2012-01-01',
      })
      .execute()
      .then(() => undefined),
  );
  return id;
}

async function createHousehold(actor: ActorFixture): Promise<string> {
  const id = newId();
  await createWithOrg(database)(actor, (trx) =>
    trx
      .insertInto('households')
      .values({ id, org_id: actor.orgId, name: 'Season End Household' })
      .execute()
      .then(() => undefined),
  );
  return id;
}

async function registerPerson(
  actor: ActorFixture,
  program: ProgramFixture,
  personId: string,
  householdId: string,
): Promise<void> {
  await createWithOrg(database)(actor, (trx) =>
    trx
      .insertInto('registrations')
      .values({
        id: newId(),
        org_id: actor.orgId,
        program_id: program.programId,
        division_id: program.divisionId,
        offering_id: program.offeringId,
        person_id: personId,
        household_id: householdId,
        registered_by_account_id: actor.accountId,
        source: 'staff',
        status: 'confirmed',
      })
      .execute()
      .then(() => undefined),
  );
}

async function createTeam(
  actor: ActorFixture,
  program: ProgramFixture,
): Promise<{ teamId: string; teamSeasonId: string }> {
  const teamId = newId();
  const teamSeasonId = newId();
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .insertInto('teams')
      .values({
        id: teamId,
        org_id: actor.orgId,
        name: 'Fixture Team',
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
  return { teamId, teamSeasonId };
}

describe('season-end operations', () => {
  it('scopes survey visibility and responses to verified family accounts and campaign dates', async () => {
    const manager = await actorWithManager();
    const linkedAccount = await actorWithManager();
    const unlinkedAccount = await actorWithManager();
    const program = await createProgram(manager);
    const personId = await createPerson(manager);
    const householdId = await createHousehold(manager);
    await registerPerson(manager, program, personId, householdId);
    await createWithOrg(database)(manager, async (trx) => {
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: manager.orgId,
          household_id: householdId,
          person_id: personId,
          role: 'guardian',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values(
          [manager.accountId, linkedAccount.accountId].map((accountId) => ({
            id: newId(),
            org_id: manager.orgId,
            person_id: personId,
            account_id: accountId,
            relationship: 'guardian' as const,
            verified_at: new Date(),
          })),
        )
        .execute();
    });

    const now = Date.now();
    await expect(
      createSeasonSurvey(manager, program.programId, {
        title: 'Invalid window',
        opensAt: new Date(now + 60_000),
        closesAt: new Date(now),
      }),
    ).rejects.toThrow(/close time must follow/i);

    const campaign = await createSeasonSurvey(manager, program.programId, {
      title: 'Family feedback',
      locale: 'es',
      opensAt: new Date(now - 60_000),
      closesAt: new Date(now + 60 * 60_000),
    });
    await expect(
      changeSeasonSurveyStatus(
        manager,
        campaign.id,
        campaign.version,
        'closed',
      ),
    ).rejects.toThrow(/status can only move/i);
    await expect(
      changeSeasonSurveyStatus(manager, campaign.id, 0, 'open'),
    ).rejects.toThrow();
    const opened = await changeSeasonSurveyStatus(
      manager,
      campaign.id,
      campaign.version,
      'open',
    );
    await expect(
      changeSeasonSurveyStatus(
        manager,
        campaign.id,
        opened.version,
        'archived',
      ),
    ).rejects.toThrow(/status can only move/i);
    await expect(
      listSeasonSurveys(manager, program.programId),
    ).resolves.toEqual([
      expect.objectContaining({ id: campaign.id, locale: 'es' }),
    ]);
    await expect(listFamilySeasonSurveys(manager)).resolves.toEqual([
      expect.objectContaining({ id: campaign.id, locale: 'es' }),
    ]);

    await expect(
      submitSeasonSurveyResponse(
        {
          orgId: manager.orgId,
          actor: { accountId: unlinkedAccount.accountId },
        },
        campaign.id,
        { nps: 8 },
      ),
    ).rejects.toThrow(/verified account linked/i);
    await submitSeasonSurveyResponse(manager, campaign.id, {
      nps: 10,
      responseText: 'Great season',
    });
    await submitSeasonSurveyResponse(
      { orgId: manager.orgId, actor: { accountId: linkedAccount.accountId } },
      campaign.id,
      { nps: 5, responseText: 'More practice time' },
    );
    await expect(listFamilySeasonSurveys(manager)).resolves.toEqual([]);
    await expect(
      submitSeasonSurveyResponse(manager, campaign.id, { nps: 7 }),
    ).rejects.toThrow();
    await expect(
      getSeasonSurveyResults(manager, campaign.id),
    ).resolves.toMatchObject({
      responseCount: 2,
      nps: 0,
      comments: [{ text: 'Great season' }, { text: 'More practice time' }],
    });
    await expect(
      getSeasonSurveyResults(linkedAccount, campaign.id),
    ).rejects.toThrow(/not found/i);

    const future = await createSeasonSurvey(manager, program.programId, {
      title: 'Opens later',
      opensAt: new Date(Date.now() + 60 * 60_000),
      closesAt: new Date(Date.now() + 2 * 60 * 60_000),
    });
    await changeSeasonSurveyStatus(manager, future.id, future.version, 'open');
    const expired = await createSeasonSurvey(manager, program.programId, {
      title: 'Already closed',
      opensAt: new Date(Date.now() - 2 * 60 * 60_000),
      closesAt: new Date(Date.now() - 60 * 60_000),
    });
    await changeSeasonSurveyStatus(
      manager,
      expired.id,
      expired.version,
      'open',
    );
    await expect(listFamilySeasonSurveys(manager)).resolves.toEqual([]);
    await expect(
      submitSeasonSurveyResponse(manager, future.id, { nps: 9 }),
    ).rejects.toThrow(/not accepting responses/i);
    await expect(
      submitSeasonSurveyResponse(manager, expired.id, { nps: 9 }),
    ).rejects.toThrow(/not accepting responses/i);
    await expect(
      changeSeasonSurveyStatus(manager, newId(), 1, 'open'),
    ).rejects.toThrow(/survey not found/i);

    const closed = await changeSeasonSurveyStatus(
      manager,
      campaign.id,
      opened.version,
      'closed',
    );
    const archived = await changeSeasonSurveyStatus(
      manager,
      campaign.id,
      closed.version,
      'archived',
    );
    expect(archived).toMatchObject({ status: 'archived', version: 4 });
  });

  it('saves coach ratings, aggregates prior seasons, issues awards, and guards season archive', async () => {
    const manager = await actorWithManager();
    const program = await createProgram(manager);
    const playerId = await createPerson(manager, {
      firstName: 'Riley',
      lastName: 'Forward',
    });
    const householdId = await createHousehold(manager);
    await registerPerson(manager, program, playerId, householdId);
    const currentTeam = await createTeam(manager, program);
    await createWithOrg(database)(manager, async (trx) => {
      await trx
        .updateTable('team_seasons')
        .set({ display_name: 'North Stars' })
        .where('org_id', '=', manager.orgId)
        .where('id', '=', currentTeam.teamSeasonId)
        .execute();
      await trx
        .insertInto('roster_entries')
        .values({
          id: newId(),
          org_id: manager.orgId,
          team_season_id: currentTeam.teamSeasonId,
          person_id: playerId,
        })
        .execute();
    });

    const firstRating = await saveCoachPlayerRating(manager, {
      teamSeasonId: currentTeam.teamSeasonId,
      personId: playerId,
      rating: 4,
      returningNextSeason: true,
      notes: 'Strong teammate',
    });
    await expect(
      saveCoachPlayerRating(manager, {
        teamSeasonId: currentTeam.teamSeasonId,
        personId: playerId,
        rating: 5,
        expectedVersion: firstRating.version,
      }),
    ).resolves.toMatchObject({ version: 2, criteria: { overall: 5 } });
    await expect(
      saveCoachPlayerRating(manager, {
        teamSeasonId: currentTeam.teamSeasonId,
        personId: playerId,
        rating: 5,
        expectedVersion: firstRating.version,
      }),
    ).rejects.toThrow();
    await expect(
      saveCoachPlayerRating(manager, {
        teamSeasonId: newId(),
        personId: playerId,
        rating: 3,
      }),
    ).rejects.toThrow(/team not found/i);
    const unrosteredPerson = await createPerson(manager);
    await expect(
      saveCoachPlayerRating(manager, {
        teamSeasonId: currentTeam.teamSeasonId,
        personId: unrosteredPerson,
        rating: 3,
      }),
    ).rejects.toThrow(/current roster member/i);
    await createWithOrg(database)(manager, (trx) =>
      trx
        .insertInto('roster_entries')
        .values({
          id: newId(),
          org_id: manager.orgId,
          team_season_id: currentTeam.teamSeasonId,
          person_id: unrosteredPerson,
        })
        .execute()
        .then(() => undefined),
    );
    await expect(
      saveCoachPlayerRating(manager, {
        teamSeasonId: currentTeam.teamSeasonId,
        personId: unrosteredPerson,
        rating: 3,
        expectedVersion: 1,
      }),
    ).rejects.toThrow();

    const priorSeasonId = newId();
    const priorProgramId = newId();
    const priorDivisionId = newId();
    const priorTeamSeasonIds = Array.from({ length: 4 }, () => newId());
    const priorTeamIds = priorTeamSeasonIds.map(() => newId());
    await createWithOrg(database)(manager, async (trx) => {
      await trx
        .insertInto('seasons')
        .values({
          id: priorSeasonId,
          org_id: manager.orgId,
          name: 'Prior Rating Season',
          starts_on: '2025-01-01',
          ends_on: '2025-12-31',
        })
        .execute();
      await trx
        .insertInto('programs')
        .values({
          id: priorProgramId,
          org_id: manager.orgId,
          season_id: priorSeasonId,
          sport_profile_id: program.sportProfileId,
          mode: 'league',
          name: 'Prior Rating Program',
          slug: `prior-${priorProgramId.slice(0, 8)}`,
          starts_on: '2025-02-01',
          ends_on: '2025-11-30',
        })
        .execute();
      await trx
        .insertInto('divisions')
        .values({
          id: priorDivisionId,
          org_id: manager.orgId,
          program_id: priorProgramId,
          name: 'Prior Division',
          level: 'open',
        })
        .execute();
      await trx
        .insertInto('teams')
        .values(
          priorTeamIds.map((id, index) => ({
            id,
            org_id: manager.orgId,
            name: `Prior Team ${String(index + 1)}`,
            sport_profile_id: program.sportProfileId,
          })),
        )
        .execute();
      await trx
        .insertInto('team_seasons')
        .values(
          priorTeamSeasonIds.map((id, index) => ({
            id,
            org_id: manager.orgId,
            team_id: priorTeamIds[index] ?? '',
            program_id: priorProgramId,
            division_id: priorDivisionId,
          })),
        )
        .execute();
      await trx
        .insertInto('roster_entries')
        .values(
          priorTeamSeasonIds.map((teamSeasonId) => ({
            id: newId(),
            org_id: manager.orgId,
            team_season_id: teamSeasonId,
            person_id: playerId,
          })),
        )
        .execute();
      await trx
        .insertInto('coach_player_ratings')
        .values(
          priorTeamSeasonIds.map((teamSeasonId, index) => ({
            id: newId(),
            org_id: manager.orgId,
            program_id: priorProgramId,
            team_season_id: teamSeasonId,
            person_id: playerId,
            coach_account_id: manager.accountId,
            criteria:
              index === 3
                ? { overall: 'not-a-number' }
                : { overall: [8, 6, 4][index] ?? 0 },
            returning_next_season: index < 2 ? true : false,
          })),
        )
        .execute();
    });
    await expect(
      getPriorSeasonPlayerRatings(manager, program.programId),
    ).resolves.toEqual({
      seasonId: priorSeasonId,
      ratings: [{ personId: playerId, rating: 6, returningNextSeason: true }],
    });
    await createWithOrg(database)(manager, (trx) =>
      trx
        .updateTable('seasons')
        .set({ copied_from_season_id: priorSeasonId })
        .where('org_id', '=', manager.orgId)
        .where('id', '=', program.seasonId)
        .execute()
        .then(() => undefined),
    );
    await expect(
      getPriorSeasonPlayerRatings(manager, program.programId),
    ).resolves.toMatchObject({ seasonId: priorSeasonId });
    await expect(getPriorSeasonPlayerRatings(manager, newId())).rejects.toThrow(
      /program not found/i,
    );

    await expect(
      createSeasonAward(manager, {
        programId: program.programId,
        title: 'No recipient',
      }),
    ).rejects.toThrow(/choose one/i);
    await expect(
      createSeasonAward(manager, {
        programId: program.programId,
        personId: playerId,
        teamSeasonId: currentTeam.teamSeasonId,
        title: 'Two recipients',
      }),
    ).rejects.toThrow(/choose one/i);
    await expect(
      createSeasonAward(manager, {
        programId: program.programId,
        personId: unrosteredPerson,
        title: 'Unregistered',
      }),
    ).rejects.toThrow(/must be registered/i);
    await expect(
      createSeasonAward(manager, {
        programId: program.programId,
        teamSeasonId: newId(),
        title: 'Missing team',
      }),
    ).rejects.toThrow(/team not found/i);
    await createSeasonAward(manager, {
      programId: program.programId,
      personId: playerId,
      title: 'Most Improved',
      description: 'Great effort',
    });
    await createSeasonAward(manager, {
      programId: program.programId,
      teamSeasonId: currentTeam.teamSeasonId,
      title: 'Team Spirit',
    });
    await expect(listSeasonAwards(manager, program.programId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Most Improved',
          recipient_first_name: 'Riley',
          recipient_last_name: 'Forward',
        }),
        expect.objectContaining({
          title: 'Team Spirit',
          recipient_team_name: 'North Stars',
        }),
      ]),
    );

    await expect(archiveSeason(manager, newId(), 1)).rejects.toThrow(
      /season not found/i,
    );
    const emptySeasonId = newId();
    await createWithOrg(database)(manager, (trx) =>
      trx
        .insertInto('seasons')
        .values({
          id: emptySeasonId,
          org_id: manager.orgId,
          name: 'Empty Season',
          starts_on: '2028-01-01',
          ends_on: '2028-12-31',
        })
        .execute()
        .then(() => undefined),
    );
    await expect(archiveSeason(manager, emptySeasonId, 1)).rejects.toThrow(
      /without programs/i,
    );
    await expect(archiveSeason(manager, program.seasonId, 2)).rejects.toThrow();
    await expect(archiveSeason(manager, program.seasonId, 1)).rejects.toThrow(
      /complete every program/i,
    );
    await createWithOrg(database)(manager, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ status: 'completed' })
        .where('org_id', '=', manager.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('seasons')
        .set({ status: 'completed' })
        .where('org_id', '=', manager.orgId)
        .where('id', '=', program.seasonId)
        .execute();
    });
    await expect(
      archiveSeason(manager, program.seasonId, 1),
    ).resolves.toMatchObject({ status: 'archived', version: 2 });

    const noPriorManager = await actorWithManager();
    const noPriorProgram = await createProgram(noPriorManager);
    await expect(
      getPriorSeasonPlayerRatings(noPriorManager, noPriorProgram.programId),
    ).resolves.toEqual({ seasonId: null, ratings: [] });
  });
});
