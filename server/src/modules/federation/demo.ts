import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { offerSpaceWindows } from './availability';
import { issueFederationDiscipline } from './discipline';
import { reviewEntry, setRosterWindow, submitEntry } from './entries';
import {
  createFeeAssessment,
  issueFeeInvoice,
  setMemberPayer,
} from './fees';
import { addReferee, assignReferee } from './officials';
import { getFederationAdminDatabase } from './privileged';
import { acceptRelationship, createRelationship } from './relationships';
import { enterHostedResult, listLeagueContests } from './results';
import {
  applyScheduleRun,
  generateLeagueSchedule,
  listHostedGames,
  publishScheduleRun,
} from './scheduling';

export interface FederationDemoIds {
  associationOrgId: string;
  clubOrgIds: string[];
  programId: string;
  teamEntryIds: string[];
}

const ASSOCIATION_SLUG = 'metro-ysa';
const CLUBS = [
  {
    slug: 'riverbend-sc',
    name: 'Riverbend Soccer Club',
    short: 'Riverbend',
    email: 'admin@riverbend-sc.example.test',
    field: 'Riverbend Field 1',
  },
  {
    slug: 'harbor-city-fc',
    name: 'Harbor City FC',
    short: 'Harbor City',
    email: 'admin@harbor-city-fc.example.test',
    field: 'Harbor Field 1',
  },
] as const;

const FIRST_NAMES = [
  'Avery',
  'Mateo',
  'Sofia',
  'Liam',
  'Nora',
  'Ezra',
  'Maya',
  'Jonah',
  'Isla',
  'Kai',
];
const LAST_NAMES = [
  'Alvarez',
  'Bennett',
  'Chow',
  'Delgado',
  'Ellis',
  'Farah',
  'Griffin',
  'Hayes',
  'Imai',
  'Jeffers',
];

async function ensureAccount(
  database: Kysely<DB>,
  email: string,
  firstName: string,
  lastName: string,
): Promise<string> {
  const existing = await database
    .selectFrom('accounts')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing) return existing.id;
  const id = newId();
  await database
    .insertInto('accounts')
    .values({
      id,
      email,
      first_name: firstName,
      last_name: lastName,
      date_of_birth: '1988-06-15',
      email_verified_at: new Date(),
    })
    .execute();
  return id;
}

async function ensureOrg(
  database: Kysely<DB>,
  input: { slug: string; name: string; kind: string },
): Promise<string> {
  const existing = await database
    .selectFrom('organizations')
    .select('id')
    .where('slug', '=', input.slug)
    .executeTakeFirst();
  if (existing) return existing.id;
  const id = newId();
  await database
    .insertInto('organizations')
    .values({
      id,
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      status: 'active',
      timezone: 'America/Chicago',
    })
    .execute();
  return id;
}

async function ensureOwner(
  database: Kysely<DB>,
  orgId: string,
  accountId: string,
): Promise<void> {
  const withOrg = createWithOrg(database);
  await withOrg({ orgId, actor: { accountId } }, async (trx) => {
    const membership = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    if (!membership) {
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
    }
    const role = await trx
      .selectFrom('role_assignments')
      .select('id')
      .where('account_id', '=', accountId)
      .where('role', '=', 'owner')
      .executeTakeFirst();
    if (!role) {
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: accountId,
          role: 'owner',
          scope_type: 'org',
          pending_mfa: true,
        })
        .execute();
    }
  });
}

async function ensureProgram(
  database: Kysely<DB>,
  org: OrgContext,
  input: {
    slug: string;
    name: string;
    divisionName: string;
    ageLabel?: string;
    teamEntry?: boolean;
  },
): Promise<{ programId: string; divisionId: string; sportProfileId: string }> {
  const withOrg = createWithOrg(database);
  return withOrg(org, async (trx) => {
    const existing = await trx
      .selectFrom('programs')
      .select('id')
      .where('slug', '=', input.slug)
      .executeTakeFirst();
    if (existing) {
      const division = await trx
        .selectFrom('divisions')
        .select('id')
        .where('program_id', '=', existing.id)
        .executeTakeFirstOrThrow();
      const profile = await trx
        .selectFrom('programs')
        .select('sport_profile_id')
        .where('id', '=', existing.id)
        .executeTakeFirstOrThrow();
      return {
        programId: existing.id,
        divisionId: division.id,
        sportProfileId: profile.sport_profile_id,
      };
    }
    const seasonId = newId();
    const sportProfileId = newId();
    const programId = newId();
    const divisionId = newId();
    const offeringId = newId();
    await trx
      .insertInto('seasons')
      .values({
        id: seasonId,
        org_id: org.orgId,
        name: '2026 Season',
        starts_on: '2026-01-01',
        ends_on: '2026-12-31',
      })
      .execute();
    await trx
      .insertInto('sport_profiles')
      .values({
        id: sportProfileId,
        org_id: org.orgId,
        name: 'Soccer',
        profile: builtInSportTemplates[0],
      })
      .execute();
    await trx
      .insertInto('programs')
      .values({
        id: programId,
        org_id: org.orgId,
        season_id: seasonId,
        sport_profile_id: sportProfileId,
        mode: 'league',
        name: input.name,
        slug: input.slug,
        starts_on: '2026-03-01',
        ends_on: '2026-07-31',
      })
      .execute();
    await trx
      .insertInto('divisions')
      .values({
        id: divisionId,
        org_id: org.orgId,
        program_id: programId,
        name: input.divisionName,
        level: 'open',
        ...(input.ageLabel ? { age_label: input.ageLabel } : {}),
      })
      .execute();
    await trx
      .insertInto('registration_offerings')
      .values({
        id: offeringId,
        org_id: org.orgId,
        program_id: programId,
        division_id: divisionId,
        name: input.teamEntry ? 'Team entry' : 'Player',
        registrant_role: input.teamEntry ? 'team_entry' : 'athlete',
        price_cents: 0,
        active: true,
      })
      .execute();
    return { programId, divisionId, sportProfileId };
  });
}

async function seedClubTeam(
  database: Kysely<DB>,
  club: OrgContext,
  input: {
    sportProfileId: string;
    programId: string;
    divisionId: string;
    name: string;
    nameOffset: number;
  },
): Promise<string> {
  const withOrg = createWithOrg(database);
  return withOrg(club, async (trx) => {
    const existing = await trx
      .selectFrom('teams')
      .select('id')
      .where('name', '=', input.name)
      .executeTakeFirst();
    if (existing) {
      const season = await trx
        .selectFrom('team_seasons')
        .select('id')
        .where('team_id', '=', existing.id)
        .executeTakeFirstOrThrow();
      return season.id;
    }
    const teamId = newId();
    const teamSeasonId = newId();
    await trx
      .insertInto('teams')
      .values({
        id: teamId,
        org_id: club.orgId,
        name: input.name,
        sport_profile_id: input.sportProfileId,
      })
      .execute();
    await trx
      .insertInto('team_seasons')
      .values({
        id: teamSeasonId,
        org_id: club.orgId,
        team_id: teamId,
        program_id: input.programId,
        division_id: input.divisionId,
      })
      .execute();
    for (let index = 0; index < 10; index += 1) {
      const personId = newId();
      const nameIndex = (input.nameOffset + index) % FIRST_NAMES.length;
      await trx
        .insertInto('people')
        .values({
          id: personId,
          org_id: club.orgId,
          first_name: FIRST_NAMES[nameIndex] ?? 'Player',
          last_name: LAST_NAMES[nameIndex] ?? 'Athlete',
          date_of_birth: `2014-${String((index % 9) + 1).padStart(2, '0')}-15`,
          media_consent: index % 4 === 0 ? 'denied' : 'granted',
        })
        .execute();
      await trx
        .insertInto('roster_entries')
        .values({
          id: newId(),
          org_id: club.orgId,
          team_season_id: teamSeasonId,
          person_id: personId,
          jersey_number: String(index + 1),
          positions: ['field'],
          status: 'active',
        })
        .execute();
    }
    return teamSeasonId;
  });
}

async function ensureSpace(
  database: Kysely<DB>,
  club: OrgContext,
  fieldName: string,
): Promise<string> {
  const withOrg = createWithOrg(database);
  return withOrg(club, async (trx) => {
    const existing = await trx
      .selectFrom('spaces')
      .select('id')
      .where('name', '=', fieldName)
      .executeTakeFirst();
    if (existing) return existing.id;
    const facilityId = newId();
    const spaceId = newId();
    await trx
      .insertInto('facilities')
      .values({
        id: facilityId,
        org_id: club.orgId,
        name: `${fieldName} Complex`,
        ownership: 'owned',
      })
      .execute();
    await trx
      .insertInto('spaces')
      .values({
        id: spaceId,
        org_id: club.orgId,
        facility_id: facilityId,
        name: fieldName,
        kind: 'field',
      })
      .execute();
    return spaceId;
  });
}

function saturdayWindow(day: string): { startsAt: string; endsAt: string } {
  return {
    startsAt: `${day}T14:00:00Z`,
    endsAt: `${day}T23:00:00Z`,
  };
}

/**
 * Seeds the Metro Youth Sports Association demo scenario: an association org
 * with two member clubs, an inter-club U12 league, submitted + approved team
 * entries with roster snapshots, a generated/published schedule using both
 * clubs' fields, entered results, a referee pool, discipline and club fees.
 * Idempotent by org slug — safe to re-run from the Phase 15 demo profile.
 */
export async function seedFederationDemo(
  database: Kysely<DB>,
): Promise<FederationDemoIds | null> {
  const already = await database
    .selectFrom('organizations')
    .select('id')
    .where('slug', '=', ASSOCIATION_SLUG)
    .executeTakeFirst();
  if (already) return null;

  const associationAccountId = await ensureAccount(
    database,
    'director@metro-ysa.example.test',
    'Jordan',
    'Reyes',
  );
  const associationOrgId = await ensureOrg(database, {
    slug: ASSOCIATION_SLUG,
    name: 'Metro Youth Sports Association',
    kind: 'association',
  });
  await ensureOwner(database, associationOrgId, associationAccountId);
  const association: OrgContext = {
    orgId: associationOrgId,
    actor: { accountId: associationAccountId },
  };

  const program = await ensureProgram(database, association, {
    slug: 'metro-u12-interclub',
    name: 'Metro U12 Inter-Club League',
    divisionName: 'U12',
    ageLabel: 'U12',
    teamEntry: true,
  });

  const admin = getFederationAdminDatabase();
  const clubOrgIds: string[] = [];
  const teamEntryIds: string[] = [];
  const clubs: { ctx: OrgContext; spaceId: string; def: (typeof CLUBS)[number] }[] =
    [];

  for (const def of CLUBS) {
    const accountId = await ensureAccount(
      database,
      def.email,
      'Club',
      'Admin',
    );
    const orgId = await ensureOrg(database, {
      slug: def.slug,
      name: def.name,
      kind: 'club',
    });
    await ensureOwner(database, orgId, accountId);
    const ctx: OrgContext = { orgId, actor: { accountId } };
    const spaceId = await ensureSpace(database, ctx, def.field);
    clubs.push({ ctx, spaceId, def });
    clubOrgIds.push(orgId);
  }

  const sharing = {
    rosters: true,
    complianceStatus: true,
    teamEntries: true,
    discipline: true,
  };
  const relationships: string[] = [];
  for (const club of clubs) {
    const relationship = await createRelationship(database, association, {
      direction: 'invite',
      organizationId: club.ctx.orgId,
      type: 'member_club',
      dataSharing: sharing,
      note: 'Metro U12 inter-club league membership',
    });
    await acceptRelationship(club.ctx, relationship.id);
    relationships.push(relationship.id);
  }

  // Saturdays inside the program window (2026-04).
  const saturdays = ['2026-04-04', '2026-04-11', '2026-04-18', '2026-04-25'];
  for (const [index, club] of clubs.entries()) {
    await offerSpaceWindows(database, club.ctx, {
      relationshipId: relationships[index] ?? '',
      spaceId: club.spaceId,
      windows: saturdays.map(saturdayWindow),
    });
  }

  // Two teams per club, each with a 10-player roster, entered into the league.
  for (const [clubIndex, club] of clubs.entries()) {
    const clubProgram = await ensureProgram(database, club.ctx, {
      slug: `${club.def.slug}-u12`,
      name: `${club.def.name} U12`,
      divisionName: 'U12',
      ageLabel: 'U12',
    });
    for (const [teamIndex, suffix] of ['Red', 'White'].entries()) {
      const teamSeasonId = await seedClubTeam(database, club.ctx, {
        sportProfileId: clubProgram.sportProfileId,
        programId: clubProgram.programId,
        divisionId: clubProgram.divisionId,
        name: `${club.def.short} U12 ${suffix}`,
        nameOffset: clubIndex * 10 + teamIndex * 5,
      });
      const entry = await submitEntry(club.ctx, {
        leagueOrgId: associationOrgId,
        programId: program.programId,
        divisionId: program.divisionId,
        teamSeasonId,
        note: `${club.def.short} U12 ${suffix} entry`,
      });
      teamEntryIds.push(entry.id);
      await reviewEntry(database, association, entry.id, {
        action: 'accept',
        version: entry.version,
      });
    }
  }

  await setRosterWindow(database, association, program.programId, {
    submitBy: '2026-03-20T23:59:59Z',
    freezeAt: '2026-04-01T00:00:00Z',
  });

  const run = await generateLeagueSchedule(association, {
    programId: program.programId,
    seed: 20260404,
    rounds: 1,
    earliestDate: '2026-04-04',
    latestDate: '2026-04-26',
    gameMinutes: 50,
    bufferMinutes: 10,
    timeWindows: [{ weekday: 6, startMinute: 540, endMinute: 1020 }],
  });
  if (run.run.status === 'succeeded' && run.draftEvents.length) {
    await applyScheduleRun(association, run.run.id);
    await publishScheduleRun(database, association, run.run.id);
  }

  // Home clubs enter results for their first hosted games.
  for (const club of clubs) {
    const hosted = await listHostedGames(club.ctx);
    const link = hosted[0];
    if (!link) continue;
    const contests = await listLeagueContests(
      database,
      association,
      program.programId,
    );
    const contest = contests.find((row) => row.eventId === link.leagueEventId);
    const home = contest?.teams.find((team) => team.side === 'home');
    const away = contest?.teams.find((team) => team.side === 'away');
    if (!contest || !home || !away) continue;
    await enterHostedResult(club.ctx, link.linkId, {
      results: [
        {
          externalTeamId: home.externalTeamId,
          score: 3,
          outcome: 'win',
          status: 'ok',
        },
        {
          externalTeamId: away.externalTeamId,
          score: 1,
          outcome: 'loss',
          status: 'ok',
        },
      ],
      finalize: true,
    });
  }

  // Referee pool + an assignment on the first scheduled contest.
  const refereeId = newId();
  const withOrg = createWithOrg(database);
  await withOrg(association, async (trx) => {
    await trx
      .insertInto('people')
      .values({
        id: refereeId,
        org_id: associationOrgId,
        first_name: 'Casey',
        last_name: 'Official',
        date_of_birth: '1985-03-12',
      })
      .execute();
  });
  await addReferee(database, association, {
    personId: refereeId,
    grade: 'regional',
    sports: [program.sportProfileId],
    maxGamesPerDay: 4,
    homeArea: 'Metro',
  });
  const scheduled = await listLeagueContests(
    database,
    association,
    program.programId,
  );
  const firstContest = scheduled.find(
    (contest) => !['final', 'canceled', 'forfeit'].includes(contest.status),
  );
  if (firstContest) {
    await assignReferee(database, association, firstContest.contestId, {
      personId: refereeId,
      positionKey: 'center',
      feeCents: 4500,
      mileageCents: 0,
    });
  }

  // One cross-club discipline record visible to the involved club.
  const firstEntryExternalTeam = await admin
    .selectFrom('external_teams')
    .select(['id', 'linked_org_id'])
    .where('org_id', '=', associationOrgId)
    .executeTakeFirst();
  if (firstEntryExternalTeam) {
    await issueFederationDiscipline(association, {
      memberOrgId: firstEntryExternalTeam.linked_org_id ?? clubOrgIds[0] ?? '',
      externalTeamId: firstEntryExternalTeam.id,
      subjectType: 'team',
      type: 'fine',
      description: 'Late match report submission',
      suspensionGames: null,
      suspensionUntil: null,
    });
  }

  // Member payer profiles + league fee invoices for both clubs.
  for (const [index, club] of clubs.entries()) {
    await setMemberPayer(club.ctx, {
      leagueOrgId: associationOrgId,
      billingAccountId: club.ctx.actor.accountId,
    });
    const assessment = await createFeeAssessment(database, association, {
      memberOrgId: club.ctx.orgId,
      programId: program.programId,
      teamEntryId: teamEntryIds[index * 2],
      description: `U12 inter-club league fee — ${club.def.name}`,
      amountCents: 25000,
      dueOn: '2026-04-01',
    });
    await issueFeeInvoice(database, association, assessment.id);
  }

  return {
    associationOrgId,
    clubOrgIds,
    programId: program.programId,
    teamEntryIds,
  };
}
