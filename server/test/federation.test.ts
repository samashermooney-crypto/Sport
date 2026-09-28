import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase, getDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { MemoryStorage } from '../src/integrations/storage/storage';
import {
  offerSpaceWindows,
  readProgramAvailability,
} from '../src/modules/federation/availability';
import { associationDashboard } from '../src/modules/federation/dashboard';
import {
  listMembers,
  listOwnSpaces,
  readMemberPhoto,
  readMemberRoster,
  readMemberTeams,
} from '../src/modules/federation/directory';
import {
  appealMemberFederationDiscipline,
  issueFederationDiscipline,
  listFederationDiscipline,
  listMemberFederationDiscipline,
  updateFederationDiscipline,
} from '../src/modules/federation/discipline';
import {
  freezeRosters,
  getLeagueEntry,
  listClubEntries,
  resubmitRoster,
  reviewEntry,
  setRosterWindow,
  submitEntry,
  withdrawEntry,
} from '../src/modules/federation/entries';
import {
  createFeeAssessment,
  issueFeeInvoice,
  listClubFees,
  listFeeAssessments,
  listMemberPayers,
  setMemberPayer,
  voidFeeAssessment,
} from '../src/modules/federation/fees';
import {
  addReferee,
  assignReferee,
  listAssignments,
  listReferees,
  updateAssignment,
} from '../src/modules/federation/officials';
import {
  getFederationAdminDatabase,
  resetFederationAdminDatabase,
} from '../src/modules/federation/privileged';
import {
  acceptRelationship,
  createRelationship,
  declineRelationship,
  endRelationship,
  listRelationships,
  proposeSharing,
  respondToSharing,
  resumeRelationship,
  searchOrganizations,
  suspendRelationship,
} from '../src/modules/federation/relationships';
import {
  enterHostedResult,
  enterLeagueResult,
  leagueStandings,
  listLeagueContests,
  memberStandings,
} from '../src/modules/federation/results';
import {
  applyScheduleRun,
  discardScheduleRun,
  generateLeagueSchedule,
  listHostedGames,
  publishScheduleRun,
} from '../src/modules/federation/scheduling';

import { createTestFactories, type ActorFixture } from './factories';

let database: Kysely<DB>;
let factory: ReturnType<typeof createTestFactories>;
let previousDatabaseUrl: string | undefined;

beforeAll(() => {
  // The privileged path uses the admin (BYPASSRLS) role; in tests that is the
  // per-file scratch database created by test/setup.ts.
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
  process.env.DATABASE_ADMIN_URL = process.env.TEST_DATABASE_URL;
  resetFederationAdminDatabase();
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  factory = createTestFactories(database);
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterAll(async () => {
  await getDatabase().destroy();
  await getFederationAdminDatabase().destroy();
  resetFederationAdminDatabase();
  await database.destroy();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

const ctx = (actor: ActorFixture) => ({
  orgId: actor.orgId,
  actor: { accountId: actor.accountId },
});

async function leagueWithProgram() {
  const league = await factory.actor();
  const program = await factory.program(league);
  await factory.scoped(league, (trx) =>
    trx
      .insertInto('registration_offerings')
      .values({
        id: newId(),
        org_id: league.orgId,
        program_id: program.programId,
        division_id: program.divisionId,
        name: 'Team entry',
        registrant_role: 'team_entry',
        price_cents: 0,
        active: true,
      })
      .execute(),
  );
  return { league, program };
}

async function clubTeam(club: ActorFixture, rosterSize = 3) {
  const program = await factory.program(club);
  const team = await factory.team(club, program);
  const people: string[] = [];
  for (let index = 0; index < rosterSize; index += 1) {
    const personId = await factory.person(club, {
      firstName: `Player${String(index)}`,
    });
    people.push(personId);
    await factory.scoped(club, (trx) =>
      trx
        .insertInto('roster_entries')
        .values({
          id: newId(),
          org_id: club.orgId,
          team_season_id: team.teamSeasonId,
          person_id: personId,
          status: 'active',
        })
        .execute(),
    );
  }
  return { program, team, people };
}

async function federate(
  league: ActorFixture,
  club: ActorFixture,
  dataSharing: Record<string, boolean> = {
    rosters: true,
    compliance_status: true,
    team_entries: true,
    discipline: true,
  },
) {
  const relationship = await createRelationship(database, ctx(league), {
    direction: 'invite',
    organizationId: club.orgId,
    type: 'member_club',
    dataSharing,
  });
  return acceptRelationship(ctx(club), relationship.id);
}

async function clubSpace(club: ActorFixture) {
  const facilityId = newId();
  const spaceId = newId();
  await factory.scoped(club, async (trx) => {
    await trx
      .insertInto('facilities')
      .values({
        id: facilityId,
        org_id: club.orgId,
        name: 'Club Complex',
        ownership: 'owned',
      })
      .execute();
    await trx
      .insertInto('spaces')
      .values({
        id: spaceId,
        org_id: club.orgId,
        facility_id: facilityId,
        name: 'Club Field',
        kind: 'field',
      })
      .execute();
  });
  return { facilityId, spaceId };
}

async function auditActions(orgId: string): Promise<string[]> {
  const rows = await getFederationAdminDatabase()
    .selectFrom('audit_log')
    .select('action')
    .where('org_id', '=', orgId)
    .execute();
  return rows.map((row) => row.action);
}

describe('federation relationships', () => {
  it('runs invite → accept → sharing amend → suspend → resume → end', async () => {
    const league = await factory.actor();
    const club = await factory.actor();

    const found = await searchOrganizations(
      database,
      ctx(league),
      club.orgId.slice(0, 8).replaceAll('-', ''),
    );
    expect(Array.isArray(found)).toBe(true);
    const ownerEmail = await getFederationAdminDatabase()
      .selectFrom('accounts')
      .select('email')
      .where('id', '=', club.accountId)
      .executeTakeFirstOrThrow();
    const ownerMatch = await searchOrganizations(
      database,
      ctx(league),
      ownerEmail.email,
    );
    expect(ownerMatch.map((organization) => organization.id)).toContain(
      club.orgId,
    );
    expect(JSON.stringify(ownerMatch)).not.toContain(ownerEmail.email);

    const invited = await createRelationship(database, ctx(league), {
      direction: 'invite',
      organizationId: club.orgId,
      type: 'member_club',
      dataSharing: { rosters: true },
      note: 'Join the league',
    });
    expect(invited.status).toBe('invited');
    expect(invited.initiator).toBe('parent');
    expect(invited.dataSharing).toEqual({});

    // The inviting side cannot accept its own invite.
    await expect(
      acceptRelationship(ctx(league), invited.id),
    ).rejects.toMatchObject({ status: 409 });

    const active = await acceptRelationship(ctx(club), invited.id);
    expect(active.status).toBe('active');
    expect(active.dataSharing).toEqual({ rosters: true });

    // The member proposes a broader agreement; the league accepts it.
    const proposed = await proposeSharing(
      ctx(club),
      invited.id,
      {
        rosters: true,
        team_entries: true,
      },
      active.version,
    );
    expect(proposed.pendingDataSharing).toEqual({
      rosters: true,
      team_entries: true,
    });
    const amended = await respondToSharing(
      ctx(league),
      invited.id,
      true,
      proposed.version,
    );
    expect(amended.dataSharing).toEqual({
      rosters: true,
      team_entries: true,
    });

    const suspended = await suspendRelationship(
      ctx(league),
      invited.id,
      'Compliance review',
      amended.version,
    );
    expect(suspended.status).toBe('suspended');

    const resumed = await resumeRelationship(
      ctx(league),
      invited.id,
      suspended.version,
    );
    expect(resumed.status).toBe('active');

    const ended = await endRelationship(
      ctx(club),
      invited.id,
      'Season over',
      resumed.version,
    );
    expect(ended.status).toBe('ended');

    const actions = await auditActions(league.orgId);
    expect(actions).toContain('federation.relationship.invited');
    expect(actions).toContain('federation.relationship.accepted');
    const clubActions = await auditActions(club.orgId);
    expect(clubActions).toContain('federation.relationship.ended');
  });

  it('rejects duplicate live relationships and honours decline', async () => {
    const league = await factory.actor();
    const club = await factory.actor();
    const input = {
      direction: 'invite' as const,
      organizationId: club.orgId,
      type: 'member_club' as const,
      dataSharing: {},
    };
    const first = await createRelationship(database, ctx(league), input);
    await expect(
      createRelationship(database, ctx(league), input),
    ).rejects.toMatchObject({ status: 409 });
    const declined = await declineRelationship(ctx(club), first.id);
    expect(declined.status).toBe('ended');
    // After ending, a fresh relationship may be created.
    const second = await createRelationship(database, ctx(league), input);
    expect(second.status).toBe('invited');
  });

  it('lets a club request membership (child-initiated)', async () => {
    const league = await factory.actor();
    const club = await factory.actor();
    const request = await createRelationship(database, ctx(club), {
      direction: 'request',
      organizationId: league.orgId,
      type: 'member_club',
      dataSharing: { team_entries: true },
    });
    expect(request.initiator).toBe('child');
    const accepted = await acceptRelationship(ctx(league), request.id);
    expect(accepted.status).toBe('active');
    expect(accepted.dataSharing).toEqual({ team_entries: true });
    const listed = await listRelationships(database, ctx(league));
    expect(listed.map((row) => row.id)).toContain(request.id);
  });
});

describe('privileged member directory reads', () => {
  it('enforces the sharing allow-list and audits both orgs', async () => {
    const { league, program } = await leagueWithProgram();
    const club = await factory.actor();
    const { team, people, program: clubProgram } = await clubTeam(club);
    const privateTeam = await factory.team(club, clubProgram);

    // Relationship grants only team_entries — roster reads must be denied.
    await federate(league, club, { team_entries: true });

    await expect(
      readMemberRoster(ctx(league), club.orgId, team.teamSeasonId),
    ).rejects.toMatchObject({ status: 422, code: 'FEDERATION_SHARING_DENIED' });

    const entry = await submitEntry(ctx(club), {
      leagueOrgId: league.orgId,
      programId: program.programId,
      divisionId: program.divisionId,
      teamSeasonId: team.teamSeasonId,
    });
    await reviewEntry(database, ctx(league), entry.id, {
      action: 'accept',
      version: entry.version,
    });

    const teams = await readMemberTeams(ctx(league), club.orgId);
    expect(teams.teams.map((row) => row.teamSeasonId)).toEqual([
      team.teamSeasonId,
    ]);
    expect(teams.teams.map((row) => row.teamSeasonId)).not.toContain(
      privateTeam.teamSeasonId,
    );
    expect(teams.teams[0]?.rosterSize).toBe(people.length);

    // Dual-org audit: the cross-org read lands in BOTH audit logs.
    const leagueAudit = await auditActions(league.orgId);
    const clubAudit = await auditActions(club.orgId);
    expect(
      leagueAudit.filter((a) => a === 'federation.cross_org.read').length,
    ).toBeGreaterThan(0);
    expect(
      clubAudit.filter((a) => a === 'federation.cross_org.read').length,
    ).toBeGreaterThan(0);
  });

  it('returns allow-listed roster fields only when rosters are shared', async () => {
    const { league, program } = await leagueWithProgram();
    await factory.scoped(league, (trx) =>
      trx
        .updateTable('divisions')
        .set({ age_label: 'U12' })
        .where('id', '=', program.divisionId)
        .execute(),
    );
    const club = await factory.actor();
    const { team } = await clubTeam(club);
    await federate(league, club);
    await submitEntry(ctx(club), {
      leagueOrgId: league.orgId,
      programId: program.programId,
      divisionId: program.divisionId,
      teamSeasonId: team.teamSeasonId,
    });

    const roster = await readMemberRoster(
      ctx(league),
      club.orgId,
      team.teamSeasonId,
    );
    expect(roster.players).toHaveLength(3);
    const player = roster.players[0];
    expect(player).toBeDefined();
    expect(Object.keys(player ?? {}).sort()).toEqual(
      [
        'personRef',
        'firstName',
        'lastName',
        'ageLabel',
        'jerseyNumber',
        'positions',
        'cardNumber',
        'photoAvailable',
      ].sort(),
    );
    expect(player?.ageLabel).toBe('U12');
    expect(player?.photoAvailable).toBe(false);
  });

  it('serves a submitted roster photo only while consent remains granted', async () => {
    const { league, program } = await leagueWithProgram();
    const club = await factory.actor();
    const { team, people } = await clubTeam(club, 1);
    const personId = people[0];
    if (!personId) throw new Error('fixture person was not created');
    await federate(league, club);
    const photoId = newId();
    const storageKey = `${club.orgId}/people/${photoId}.webp`;
    const image = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
    const storage = new MemoryStorage();
    await storage.put(storageKey, image, 'image/webp');
    await factory.scoped(club, async (trx) => {
      await trx
        .insertInto('files')
        .values({
          id: photoId,
          org_id: club.orgId,
          purpose: 'image',
          owner_type: 'person',
          owner_id: personId,
          storage_key: storageKey,
          mime: 'image/webp',
          bytes: image.byteLength,
          sensitivity: 'sensitive',
          created_by: club.accountId,
          upload_state: 'complete',
        })
        .execute();
      await trx
        .updateTable('people')
        .set({ media_consent: 'granted', photo_file_id: photoId })
        .where('org_id', '=', club.orgId)
        .where('id', '=', personId)
        .execute();
    });
    await submitEntry(ctx(club), {
      leagueOrgId: league.orgId,
      programId: program.programId,
      divisionId: program.divisionId,
      teamSeasonId: team.teamSeasonId,
    });

    const roster = await readMemberRoster(
      ctx(league),
      club.orgId,
      team.teamSeasonId,
    );
    expect(roster.players[0]?.photoAvailable).toBe(true);
    const photo = await readMemberPhoto(
      ctx(league),
      club.orgId,
      team.teamSeasonId,
      personId,
      storage,
    );
    expect(photo.mimeType).toBe('image/webp');
    expect(Buffer.from(photo.base64, 'base64')).toEqual(Buffer.from(image));

    await factory.scoped(club, (trx) =>
      trx
        .updateTable('people')
        .set({ media_consent: 'denied' })
        .where('org_id', '=', club.orgId)
        .where('id', '=', personId)
        .execute()
        .then(() => undefined),
    );
    expect(
      (await readMemberRoster(ctx(league), club.orgId, team.teamSeasonId))
        .players[0]?.photoAvailable,
    ).toBe(false);
    await expect(
      readMemberPhoto(
        ctx(league),
        club.orgId,
        team.teamSeasonId,
        personId,
        storage,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('fails when the relationship is suspended', async () => {
    const league = await factory.actor();
    const club = await factory.actor();
    const relationship = await federate(league, club);
    await suspendRelationship(
      ctx(league),
      relationship.id,
      'pause',
      relationship.version,
    );
    await expect(
      readMemberTeams(ctx(league), club.orgId),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('team entries and roster snapshots', () => {
  it('submits an entry with an immutable allow-listed roster snapshot', async () => {
    const { league, program } = await leagueWithProgram();
    const club = await factory.actor();
    const { program: clubProgram, team } = await clubTeam(club);
    await federate(league, club);

    const view = await submitEntry(ctx(club), {
      leagueOrgId: league.orgId,
      programId: program.programId,
      divisionId: program.divisionId,
      teamSeasonId: team.teamSeasonId,
    });
    expect(view.status).toBe('pending_approval');
    expect(view.memberOrgId).toBe(club.orgId);
    expect(view.snapshot?.playerCount).toBe(3);
    expect(view.externalTeamId).toBeTruthy();

    const detail = await getLeagueEntry(database, ctx(league), view.id);
    expect(detail.roster?.players).toHaveLength(3);
    expect(detail.roster?.players[0]).not.toHaveProperty('email');
    expect(detail.roster?.players[0]).not.toHaveProperty('photoFileId');
    expect(detail.roster?.players[0]).not.toHaveProperty('birthYear');

    const reviewed = await reviewEntry(database, ctx(league), view.id, {
      action: 'accept',
      version: view.version,
    });
    expect(reviewed.status).toBe('accepted');

    const clubList = await listClubEntries(ctx(club));
    expect(clubList.map((entry) => entry.id)).toContain(view.id);

    // The same team cannot be entered twice, but a second team from the
    // same club may enter the program.
    await expect(
      submitEntry(ctx(club), {
        leagueOrgId: league.orgId,
        programId: program.programId,
        divisionId: program.divisionId,
        teamSeasonId: team.teamSeasonId,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      factory.scoped(league, (trx) =>
        trx
          .updateTable('federation_roster_snapshots')
          .set({ roster: { altered: true } })
          .where('org_id', '=', league.orgId)
          .where('id', '=', view.snapshot?.id ?? '')
          .execute(),
      ),
    ).rejects.toThrow('federation roster snapshots are immutable');
    const other = await factory.team(club, clubProgram);
    const second = await submitEntry(ctx(club), {
      leagueOrgId: league.orgId,
      programId: program.programId,
      divisionId: program.divisionId,
      teamSeasonId: other.teamSeasonId,
    });
    expect(second.status).toBe('pending_approval');
  });

  it('enforces roster deadlines and freezes', async () => {
    const { league, program } = await leagueWithProgram();
    const club = await factory.actor();
    const { team } = await clubTeam(club);
    await federate(league, club);

    // A past deadline blocks new submissions.
    await setRosterWindow(database, ctx(league), program.programId, {
      submitBy: '2020-01-01T00:00:00Z',
    });
    await expect(
      submitEntry(ctx(club), {
        leagueOrgId: league.orgId,
        programId: program.programId,
        divisionId: program.divisionId,
        teamSeasonId: team.teamSeasonId,
      }),
    ).rejects.toMatchObject({ status: 422 });

    // Reopen the window, submit, then freeze.
    await setRosterWindow(database, ctx(league), program.programId, {
      submitBy: '2030-01-01T00:00:00Z',
    });
    const view = await submitEntry(ctx(club), {
      leagueOrgId: league.orgId,
      programId: program.programId,
      divisionId: program.divisionId,
      teamSeasonId: team.teamSeasonId,
    });
    const resubmitted = await resubmitRoster(ctx(club), league.orgId, view.id);
    expect(resubmitted.playerCount).toBe(3);

    const { frozen } = await freezeRosters(
      database,
      ctx(league),
      program.programId,
    );
    expect(frozen).toBe(1);
    await expect(
      resubmitRoster(ctx(club), league.orgId, view.id),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('lets a club withdraw its entry', async () => {
    const { league, program } = await leagueWithProgram();
    const club = await factory.actor();
    const { team } = await clubTeam(club);
    await federate(league, club);
    const view = await submitEntry(ctx(club), {
      leagueOrgId: league.orgId,
      programId: program.programId,
      divisionId: program.divisionId,
      teamSeasonId: team.teamSeasonId,
    });
    const withdrawn = await withdrawEntry(ctx(club), league.orgId, view.id);
    expect(withdrawn.status).toBe('withdrawn');
  });
});

describe('league scheduling on member-club availability', () => {
  it('uses each space facility timezone, falling back to its organization timezone', async () => {
    const club = await factory.actor();
    const chicago = await clubSpace(club);
    const phoenix = await clubSpace(club);
    await factory.scoped(club, (trx) =>
      trx
        .updateTable('organizations')
        .set({ timezone: 'America/Denver' })
        .where('id', '=', club.orgId)
        .execute(),
    );
    await factory.scoped(club, (trx) =>
      trx
        .updateTable('facilities')
        .set({ timezone: null })
        .where('org_id', '=', club.orgId)
        .where('id', '=', chicago.facilityId)
        .execute(),
    );
    await factory.scoped(club, (trx) =>
      trx
        .updateTable('facilities')
        .set({ timezone: 'America/Phoenix' })
        .where('org_id', '=', club.orgId)
        .where('id', '=', phoenix.facilityId)
        .execute(),
    );

    const spaces = await listOwnSpaces(database, ctx(club));
    expect(
      spaces.find((space) => space.spaceId === chicago.spaceId)?.timezone,
    ).toBe('America/Denver');
    expect(
      spaces.find((space) => space.spaceId === phoenix.spaceId)?.timezone,
    ).toBe('America/Phoenix');
  });

  it('generates, applies and publishes a hosted schedule', async () => {
    const { league, program } = await leagueWithProgram();
    const clubA = await factory.actor();
    const clubB = await factory.actor();
    const { team: teamA } = await clubTeam(clubA);
    const { team: teamB } = await clubTeam(clubB);
    const relA = await federate(league, clubA);
    const relB = await federate(league, clubB);
    const spaceA = await clubSpace(clubA);
    const spaceB = await clubSpace(clubB);

    // 2026-09-26 is a Saturday (ISO weekday 6); windows in America/Chicago.
    const window = {
      startsAt: '2026-09-26T14:00:00Z',
      endsAt: '2026-09-26T23:00:00Z',
    };
    const offered = await offerSpaceWindows(database, ctx(clubA), {
      relationshipId: relA.id,
      spaceId: spaceA.spaceId,
      windows: [window],
    });
    expect(offered.created).toBe(1);
    await offerSpaceWindows(database, ctx(clubB), {
      relationshipId: relB.id,
      spaceId: spaceB.spaceId,
      windows: [window],
    });

    const availabilityRead = await readProgramAvailability(
      ctx(league),
      program.programId,
    );
    expect(
      availabilityRead.spaces.filter((s) => s.ownerOrgId !== league.orgId),
    ).toHaveLength(2);

    for (const [club, team] of [
      [clubA, teamA],
      [clubB, teamB],
    ] as const) {
      const entry = await submitEntry(ctx(club), {
        leagueOrgId: league.orgId,
        programId: program.programId,
        divisionId: program.divisionId,
        teamSeasonId: team.teamSeasonId,
      });
      await reviewEntry(database, ctx(league), entry.id, {
        action: 'accept',
        version: entry.version,
      });
    }

    const generated = await generateLeagueSchedule(ctx(league), {
      programId: program.programId,
      seed: 7,
      rounds: 1,
      earliestDate: '2026-09-26',
      latestDate: '2026-09-27',
      gameMinutes: 60,
      bufferMinutes: 15,
      timeWindows: [{ weekday: 6, startMinute: 540, endMinute: 1080 }],
    });
    expect(generated.run.status).toBe('succeeded');
    expect(generated.draftEvents.length).toBeGreaterThan(0);

    const applied = await applyScheduleRun(ctx(league), generated.run.id);
    expect(applied.applied).toBeGreaterThan(0);
    expect(applied.hosted).toBeGreaterThan(0); // games on member-club spaces

    const hosted = await listHostedGames(ctx(clubA));
    const hostedB = await listHostedGames(ctx(clubB));
    expect(hosted.length + hostedB.length).toBe(applied.hosted);

    const published = await publishScheduleRun(
      database,
      ctx(league),
      generated.run.id,
    );
    expect(published.published).toBe(applied.applied);

    // Re-applying is refused.
    await expect(
      applyScheduleRun(ctx(league), generated.run.id),
    ).rejects.toMatchObject({ status: 409 });

    // Discarding a fresh run works.
    const second = await generateLeagueSchedule(ctx(league), {
      programId: program.programId,
      seed: 8,
      rounds: 1,
      earliestDate: '2026-09-26',
      latestDate: '2026-09-27',
      gameMinutes: 60,
      bufferMinutes: 15,
      timeWindows: [{ weekday: 6, startMinute: 540, endMinute: 1080 }],
    });
    await discardScheduleRun(database, ctx(league), second.run.id);
  });

  it('blocks contribution windows that overlap an existing booking', async () => {
    const { league } = await leagueWithProgram();
    const club = await factory.actor();
    const rel = await federate(league, club);
    const { spaceId } = await clubSpace(club);
    const eventId = await factory.event(club);
    const { bookSpace } = await import('../src/db/bookSpace');
    await bookSpace(database, ctx(club), {
      spaceId,
      startsAt: '2026-09-26T16:00:00Z',
      endsAt: '2026-09-26T18:00:00Z',
      eventId,
    });
    await expect(
      offerSpaceWindows(database, ctx(club), {
        relationshipId: rel.id,
        spaceId,
        windows: [
          { startsAt: '2026-09-26T17:00:00Z', endsAt: '2026-09-26T20:00:00Z' },
        ],
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('results, standings and discipline', () => {
  async function scheduledProgram() {
    const { league, program } = await leagueWithProgram();
    const clubA = await factory.actor();
    const clubB = await factory.actor();
    const { team: teamA } = await clubTeam(clubA);
    const { team: teamB } = await clubTeam(clubB);
    const relA = await federate(league, clubA);
    await federate(league, clubB);
    const { spaceId } = await clubSpace(clubA);
    await offerSpaceWindows(database, ctx(clubA), {
      relationshipId: relA.id,
      spaceId,
      windows: [
        { startsAt: '2026-09-26T14:00:00Z', endsAt: '2026-09-26T23:00:00Z' },
      ],
    });
    const entryIds: string[] = [];
    for (const [club, team] of [
      [clubA, teamA],
      [clubB, teamB],
    ] as const) {
      const entry = await submitEntry(ctx(club), {
        leagueOrgId: league.orgId,
        programId: program.programId,
        divisionId: program.divisionId,
        teamSeasonId: team.teamSeasonId,
      });
      await reviewEntry(database, ctx(league), entry.id, {
        action: 'accept',
        version: entry.version,
      });
      entryIds.push(entry.externalTeamId);
    }
    const generated = await generateLeagueSchedule(ctx(league), {
      programId: program.programId,
      seed: 3,
      rounds: 1,
      earliestDate: '2026-09-26',
      latestDate: '2026-09-27',
      gameMinutes: 60,
      bufferMinutes: 15,
      timeWindows: [{ weekday: 6, startMinute: 540, endMinute: 1080 }],
    });
    await applyScheduleRun(ctx(league), generated.run.id);
    return { league, program, clubA, clubB, entryIds };
  }

  it('records league-side results and computes standings', async () => {
    const { league, program, clubA, entryIds } = await scheduledProgram();
    const contests = await listLeagueContests(
      database,
      ctx(league),
      program.programId,
    );
    expect(contests.length).toBeGreaterThan(0);
    const contest = contests[0];
    if (!contest) throw new Error('expected a league contest');
    const [home, away] = entryIds as [string, string];

    const entered = await enterLeagueResult(
      database,
      ctx(league),
      contest.contestId,
      {
        results: [
          { externalTeamId: home, score: 3, outcome: 'win', status: 'ok' },
          { externalTeamId: away, score: 1, outcome: 'loss', status: 'ok' },
        ],
        finalize: true,
      },
    );
    expect(entered.status).toBe('final');

    const standings = await leagueStandings(
      database,
      ctx(league),
      program.programId,
    );
    expect(standings.length).toBeGreaterThan(0);
    const division = standings[0];
    const homeRow = division?.rows.find((row) => row.teamId === home);
    expect(homeRow?.wins).toBe(1);

    const memberView = await memberStandings(
      ctx(clubA),
      league.orgId,
      program.programId,
    );
    expect(memberView.length).toBe(standings.length);
  });

  it('lets the host club enter the result through the federation link', async () => {
    const { league, clubA, entryIds } = await scheduledProgram();
    const hosted = await listHostedGames(ctx(clubA));
    expect(hosted.length).toBeGreaterThan(0);
    const link = hosted[0];
    if (!link) throw new Error('expected a hosted game link');
    const [home, away] = entryIds as [string, string];
    const entered = await enterHostedResult(ctx(clubA), link.linkId, {
      results: [
        { externalTeamId: home, score: 2, status: 'ok' },
        { externalTeamId: away, score: 2, status: 'ok' },
      ],
      finalize: true,
      reason: 'Match report',
    });
    expect(entered.status).toBe('final');
    const audit = await auditActions(clubA.orgId);
    expect(audit).toContain('federation.result.entered_by_member');
    const leagueAudit = await auditActions(league.orgId);
    expect(leagueAudit).toContain('federation.result.entered_by_member');
  });

  it('issues, serves and overturns cross-club discipline', async () => {
    const { league, program, clubA, entryIds } = await scheduledProgram();
    const contests = await listLeagueContests(
      database,
      ctx(league),
      program.programId,
    );
    const record = await issueFederationDiscipline(ctx(league), {
      memberOrgId: clubA.orgId,
      contestId: contests[0]?.contestId ?? null,
      externalTeamId: entryIds[0] ?? null,
      subjectType: 'team',
      type: 'suspension',
      description: 'Fielded an ineligible player',
      suspensionGames: 2,
    });
    expect(record.status).toBe('active');
    expect(record.memberOrgId).toBe(clubA.orgId);

    const served = await updateFederationDiscipline(
      database,
      ctx(league),
      record.id,
      { action: 'serve_games', games: 2, version: record.version },
    );
    expect(served.status).toBe('served');

    const memberRecords = await listMemberFederationDiscipline(ctx(clubA));
    expect(memberRecords.map((row) => row.id)).toContain(record.id);
    const leagueRecords = await listFederationDiscipline(
      database,
      ctx(league),
      clubA.orgId,
    );
    expect(leagueRecords).toHaveLength(1);

    const second = await issueFederationDiscipline(ctx(league), {
      memberOrgId: clubA.orgId,
      subjectType: 'person',
      personRef: newId(),
      personLabel: 'Coach A',
      type: 'ejection',
      description: 'Dissent',
    });
    const appealed = await updateFederationDiscipline(
      database,
      ctx(league),
      second.id,
      { action: 'appeal', version: second.version },
    );
    expect(appealed.status).toBe('appealed');
    const overturned = await updateFederationDiscipline(
      database,
      ctx(league),
      second.id,
      { action: 'overturn', version: appealed.version },
    );
    expect(overturned.status).toBe('overturned');

    const clubAppealable = await issueFederationDiscipline(ctx(league), {
      memberOrgId: clubA.orgId,
      subjectType: 'person',
      personRef: newId(),
      personLabel: 'Player A',
      type: 'caution',
      description: 'Unsporting conduct',
    });
    const memberAppeal = await appealMemberFederationDiscipline(
      ctx(clubA),
      clubAppealable.id,
      clubAppealable.version,
    );
    expect(memberAppeal.status).toBe('appealed');
    expect(await auditActions(league.orgId)).toContain(
      'federation.discipline.appealed',
    );
    expect(await auditActions(clubA.orgId)).toContain(
      'federation.discipline.appealed',
    );
  });
});

describe('league referee pool', () => {
  it('adds referees, assigns them and tracks status', async () => {
    const league = await factory.actor();
    const personId = await factory.person(league, {
      firstName: 'Ref',
      lastName: 'One',
    });
    const referee = await addReferee(database, ctx(league), {
      personId,
      grade: 'C',
    });
    expect(referee.active).toBe(true);
    expect((await listReferees(database, ctx(league)))[0]?.personId).toBe(
      personId,
    );

    const eventId = await factory.event(league);
    const program = await factory.program(league);
    const contestId = await factory.contest(
      league,
      eventId,
      program.sportProfileId,
    );
    const assigned = await assignReferee(database, ctx(league), contestId, {
      personId,
      positionKey: 'center',
      feeCents: 6500,
      mileageCents: 500,
    });
    expect(assigned.status).toBe('offered');
    const accepted = await updateAssignment(
      database,
      ctx(league),
      assigned.id,
      { action: 'accept' },
    );
    expect(accepted.status).toBe('accepted');
    const confirmed = await updateAssignment(
      database,
      ctx(league),
      assigned.id,
      { action: 'confirm' },
    );
    expect(confirmed.status).toBe('confirmed');
    await expect(
      updateAssignment(database, ctx(league), assigned.id, {
        action: 'accept',
      }),
    ).rejects.toMatchObject({ status: 409 });
    const listed = await listAssignments(database, ctx(league), contestId);
    expect(listed[0]?.status).toBe('confirmed');
  });
});

describe('league fees and member payers', () => {
  it('bills member clubs through the finance invoice pipeline', async () => {
    const { league, program } = await leagueWithProgram();
    const club = await factory.actor();
    await federate(league, club);

    // Issuing without a payer fails cleanly.
    const assessment = await createFeeAssessment(database, ctx(league), {
      memberOrgId: club.orgId,
      programId: program.programId,
      description: 'Season registration fee',
      amountCents: 25000,
      dueOn: '2026-10-01',
    });
    expect(assessment.status).toBe('draft');
    await expect(
      issueFeeInvoice(database, ctx(league), assessment.id),
    ).rejects.toMatchObject({ status: 422 });

    const payer = await setMemberPayer(ctx(club), {
      leagueOrgId: league.orgId,
      billingAccountId: club.accountId,
    });
    expect(payer.memberOrgId).toBe(club.orgId);
    const payers = await listMemberPayers(database, ctx(league));
    expect(payers[0]?.billingAccountId).toBe(club.accountId);

    const issued = await issueFeeInvoice(database, ctx(league), assessment.id);
    expect(issued.invoiceId).toBeTruthy();
    expect(issued.invoiceNumber).toBeGreaterThan(0);

    // Idempotent: re-issue replays the same invoice.
    const replayed = await issueFeeInvoice(
      database,
      ctx(league),
      assessment.id,
    );
    expect(replayed.invoiceId).toBe(issued.invoiceId);

    const listed = await listFeeAssessments(database, ctx(league));
    expect(listed[0]?.status).toBe('invoiced');
    expect(listed[0]?.invoiceId).toBe(issued.invoiceId);

    const clubView = await listClubFees(ctx(club), league.orgId);
    expect(clubView[0]?.invoiceStatus).toBeTruthy();

    // Voiding clears the invoice too.
    await voidFeeAssessment(database, ctx(league), assessment.id, 'Refund');
    const invoice = await factory.scoped(league, (trx) =>
      trx
        .selectFrom('invoices')
        .select('status')
        .where('id', '=', issued.invoiceId)
        .executeTakeFirstOrThrow(),
    );
    expect(invoice.status).toBe('void');
  });
});

describe('association dashboard', () => {
  it('summarises members, entries, discipline, fees and schedule', async () => {
    const { league, program } = await leagueWithProgram();
    const club = await factory.actor();
    const { team } = await clubTeam(club);
    await federate(league, club);
    await submitEntry(ctx(club), {
      leagueOrgId: league.orgId,
      programId: program.programId,
      divisionId: program.divisionId,
      teamSeasonId: team.teamSeasonId,
    });
    await createFeeAssessment(database, ctx(league), {
      memberOrgId: club.orgId,
      description: 'Affiliation fee',
      amountCents: 10000,
    });
    const dashboard = await associationDashboard(database, ctx(league));
    expect(dashboard.members.total).toBe(1);
    expect(dashboard.members.active).toBe(1);
    expect(dashboard.entries['pending_approval']).toBe(1);
    expect(dashboard.fees.assessedCents).toBe(10000);
    const members = await listMembers(database, ctx(league));
    expect(members[0]?.memberOrgId).toBe(club.orgId);
  });
});
