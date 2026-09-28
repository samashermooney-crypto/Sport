import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { createContest, submitContestResult } from '../contests/service';

import { createBracket, generateBracket, setBracketContest } from './service';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error(
      'TEST_DATABASE_APP_URL is required for bracket progression tests.',
    );
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});

afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

async function createActor(): Promise<OrgContext & { accountId: string }> {
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `bracket-${accountId}@example.invalid`,
      first_name: 'Bracket',
      last_name: 'Owner',
      date_of_birth: '1990-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `bracket-${orgId.slice(0, 8)}`,
      name: 'Bracket Test Organization',
      kind: 'club',
      timezone: 'UTC',
    })
    .execute();
  const context = { orgId, accountId, actor: { accountId } };
  await createWithOrg(database)(context, async (trx) => {
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
  return context;
}

async function createProgram(
  actor: OrgContext & { accountId: string },
): Promise<{ programId: string; divisionId: string }> {
  const profile = builtInSportTemplates[0];
  const seasonId = newId();
  const sportProfileId = newId();
  const programId = newId();
  const divisionId = newId();
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .insertInto('seasons')
      .values({
        id: seasonId,
        org_id: actor.orgId,
        name: 'Bracket Test Season',
        starts_on: '2026-01-01',
        ends_on: '2026-12-31',
      })
      .execute();
    await trx
      .insertInto('sport_profiles')
      .values({
        id: sportProfileId,
        org_id: actor.orgId,
        name: profile.key,
        profile,
      })
      .execute();
    const snapshot = await trx
      .selectFrom('sport_profile_versions')
      .select('version')
      .where('org_id', '=', actor.orgId)
      .where('sport_profile_id', '=', sportProfileId)
      .where('version', '=', 1)
      .executeTakeFirst();
    if (!snapshot)
      await trx
        .insertInto('sport_profile_versions')
        .values({
          org_id: actor.orgId,
          sport_profile_id: sportProfileId,
          version: 1,
          profile,
          created_by: actor.accountId,
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
        name: 'Bracket Test League',
        slug: `bracket-${programId.slice(0, 8)}`,
        starts_on: '2026-01-01',
        ends_on: '2026-12-31',
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
  });
  return { programId, divisionId };
}

async function createTeam(
  actor: OrgContext,
  programId: string,
  divisionId: string,
  name: string,
): Promise<string> {
  const teamId = newId();
  const teamSeasonId = newId();
  await createWithOrg(database)(actor, async (trx) => {
    const sportProfile = await trx
      .selectFrom('programs')
      .select('sport_profile_id')
      .where('org_id', '=', actor.orgId)
      .where('id', '=', programId)
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('teams')
      .values({
        id: teamId,
        org_id: actor.orgId,
        name,
        sport_profile_id: sportProfile.sport_profile_id,
      })
      .execute();
    await trx
      .insertInto('team_seasons')
      .values({
        id: teamSeasonId,
        org_id: actor.orgId,
        team_id: teamId,
        program_id: programId,
        division_id: divisionId,
      })
      .execute();
  });
  return teamSeasonId;
}

describe('tournament contest progression', () => {
  it('advances a bracket and completes it when its contest result is finalized', async () => {
    const actor = await createActor();
    const program = await createProgram(actor);
    const firstTeamSeasonId = await createTeam(
      actor,
      program.programId,
      program.divisionId,
      'Bracket Home',
    );
    const secondTeamSeasonId = await createTeam(
      actor,
      program.programId,
      program.divisionId,
      'Bracket Away',
    );
    const bracket = await createBracket(actor, {
      programId: program.programId,
      divisionId: program.divisionId,
      name: 'Finals bracket',
      type: 'single_elim',
      seedingSource: 'manual',
      entries: [
        { teamSeasonId: firstTeamSeasonId, seed: 1 },
        { teamSeasonId: secondTeamSeasonId, seed: 2 },
      ],
    });
    await generateBracket(actor, bracket.id, bracket.version);

    const withOrg = createWithOrg(database);
    const match = await withOrg(actor, (trx) =>
      trx
        .selectFrom('bracket_matches')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .where('bracket_id', '=', bracket.id)
        .executeTakeFirstOrThrow(),
    );
    const firstSlot = match.participant_a as unknown as {
      entrantId: string | null;
    };
    const secondSlot = match.participant_b as unknown as {
      entrantId: string | null;
    };
    if (!firstSlot.entrantId || !secondSlot.entrantId)
      throw new Error('Generated final must contain both seeded teams.');

    const eventId = newId();
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await withOrg(actor, async (trx) => {
      await trx
        .insertInto('events')
        .values({
          id: eventId,
          org_id: actor.orgId,
          program_id: program.programId,
          division_id: program.divisionId,
          kind: 'game',
          title: 'Bracket final',
          starts_at: startsAt,
          ends_at: new Date(startsAt.getTime() + 60 * 60 * 1000),
          timezone: 'UTC',
        })
        .execute();
      await trx
        .insertInto('event_participants')
        .values([
          {
            id: newId(),
            org_id: actor.orgId,
            event_id: eventId,
            team_season_id: firstSlot.entrantId,
            side: 'home',
          },
          {
            id: newId(),
            org_id: actor.orgId,
            event_id: eventId,
            team_season_id: secondSlot.entrantId,
            side: 'away',
          },
        ])
        .execute();
    });
    const contest = await createContest(actor, eventId, {
      formatIndex: 0,
      stage: 'playoff',
      countsForStandings: false,
    });
    await setBracketContest(
      actor,
      bracket.id,
      match.id,
      contest.id,
      match.version,
    );

    const result = await submitContestResult(actor, contest.id, {
      expectedVersion: contest.version,
      result: { home: 2, away: 1 },
      finalize: true,
    });
    expect(result.status).toBe('final');

    const state = await withOrg(actor, async (trx) => ({
      bracket: await trx
        .selectFrom('brackets')
        .select('status')
        .where('org_id', '=', actor.orgId)
        .where('id', '=', bracket.id)
        .executeTakeFirstOrThrow(),
      match: await trx
        .selectFrom('bracket_matches')
        .select(['participant_a', 'participant_b'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', match.id)
        .executeTakeFirstOrThrow(),
    }));
    expect(state.bracket.status).toBe('completed');
    expect(state.match.participant_a).toMatchObject({
      entrantId: firstSlot.entrantId,
      winnerId: firstSlot.entrantId,
      finalized: true,
    });
    expect(state.match.participant_b).toMatchObject({
      entrantId: secondSlot.entrantId,
      winnerId: firstSlot.entrantId,
      finalized: true,
    });
  });
});
