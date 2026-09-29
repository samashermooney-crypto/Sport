import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import {
  attendanceReport,
  checkOutAthlete,
  coachGameDay,
  listEventAttendance,
  rsvpForChild,
  saveLineup,
  setAttendance,
} from './service';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for attendance tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});

afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

describe('attendance discipline integration', () => {
  it('blocks a suspended lineup and commits the discipline audit record', async () => {
    const accountId = newId();
    const orgId = newId();
    const personId = newId();
    const pickupPersonId = newId();
    const householdId = newId();
    const profileId = newId();
    const seasonId = newId();
    const programId = newId();
    const divisionId = newId();
    const teamId = newId();
    const teamSeasonId = newId();
    const eventId = newId();
    const contestId = newId();
    const disciplineId = newId();
    const actor: OrgContext = { orgId, actor: { accountId } };
    const withOrg = createWithOrg(database);
    const profile = builtInSportTemplates[0];

    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `attendance-${accountId}@example.invalid`,
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
        slug: `attendance-${orgId.slice(0, 8)}`,
        name: 'Attendance Test',
        kind: 'club',
        timezone: 'America/Chicago',
      })
      .execute();

    await withOrg(actor, async (trx) => {
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
      await trx
        .insertInto('people')
        .values({
          id: personId,
          org_id: orgId,
          first_name: 'Suspended',
          last_name: 'Player',
          date_of_birth: '2012-01-01',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: orgId,
          person_id: personId,
          account_id: accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('people')
        .values({
          id: pickupPersonId,
          org_id: orgId,
          first_name: 'Authorized',
          last_name: 'Guardian',
          date_of_birth: '1985-01-01',
        })
        .execute();
      await trx
        .insertInto('households')
        .values({ id: householdId, org_id: orgId, name: 'Player Household' })
        .execute();
      await trx
        .insertInto('household_members')
        .values([
          {
            id: newId(),
            org_id: orgId,
            household_id: householdId,
            person_id: personId,
            role: 'athlete',
            is_primary_contact: false,
            receives_communications: false,
            financially_responsible: false,
            can_pick_up: false,
            lives_here: true,
          },
          {
            id: newId(),
            org_id: orgId,
            household_id: householdId,
            person_id: pickupPersonId,
            role: 'guardian',
            is_primary_contact: true,
            receives_communications: true,
            financially_responsible: true,
            can_pick_up: true,
            lives_here: true,
          },
        ])
        .execute();
      await trx
        .insertInto('sport_profiles')
        .values({ id: profileId, org_id: orgId, name: 'Soccer', profile })
        .execute();
      const profileVersion = await trx
        .selectFrom('sport_profile_versions')
        .select('version')
        .where('org_id', '=', orgId)
        .where('sport_profile_id', '=', profileId)
        .where('version', '=', 1)
        .executeTakeFirst();
      if (!profileVersion)
        await trx
          .insertInto('sport_profile_versions')
          .values({
            org_id: orgId,
            sport_profile_id: profileId,
            version: 1,
            profile,
            created_by: accountId,
          })
          .execute();
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: 'Fall 2026',
          starts_on: '2026-08-01',
          ends_on: '2026-11-30',
        })
        .execute();
      await trx
        .insertInto('programs')
        .values({
          id: programId,
          org_id: orgId,
          season_id: seasonId,
          sport_profile_id: profileId,
          mode: 'league',
          name: 'Fall League',
          slug: `attendance-${orgId.slice(0, 8)}`,
          starts_on: '2026-08-01',
          ends_on: '2026-11-30',
        })
        .execute();
      await trx
        .insertInto('divisions')
        .values({
          id: divisionId,
          org_id: orgId,
          program_id: programId,
          name: 'U14',
        })
        .execute();
      await trx
        .insertInto('teams')
        .values({
          id: teamId,
          org_id: orgId,
          name: 'North',
          sport_profile_id: profileId,
        })
        .execute();
      await trx
        .insertInto('team_seasons')
        .values({
          id: teamSeasonId,
          org_id: orgId,
          team_id: teamId,
          program_id: programId,
          division_id: divisionId,
        })
        .execute();
      await trx
        .insertInto('roster_entries')
        .values({
          id: newId(),
          org_id: orgId,
          team_season_id: teamSeasonId,
          person_id: personId,
        })
        .execute();
      await trx
        .insertInto('events')
        .values({
          id: eventId,
          org_id: orgId,
          program_id: programId,
          division_id: divisionId,
          kind: 'game',
          title: 'North vs South',
          starts_at: '2026-10-10T12:00:00Z',
          ends_at: '2026-10-10T13:00:00Z',
          timezone: 'America/Chicago',
        })
        .execute();
      await trx
        .insertInto('event_participants')
        .values({
          id: newId(),
          org_id: orgId,
          event_id: eventId,
          team_season_id: teamSeasonId,
          side: 'home',
        })
        .execute();
      await trx
        .insertInto('contests')
        .values({
          id: contestId,
          org_id: orgId,
          event_id: eventId,
          sport_profile_id: profileId,
          profile_version: 1,
          format: 'head_to_head_score',
        })
        .execute();
      await trx
        .insertInto('discipline_records')
        .values({
          id: disciplineId,
          org_id: orgId,
          person_id: personId,
          team_season_id: teamSeasonId,
          contest_id: contestId,
          type: 'send_off',
          description: 'One game suspension',
          suspension_games: 1,
          issued_by: accountId,
        })
        .execute();
    });

    await expect(
      saveLineup(actor, contestId, teamSeasonId, [
        { personId, position: 'gk', order: 0 },
      ]),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });

    const rsvp = await rsvpForChild(actor, eventId, personId, 'yes');
    expect(rsvp.rsvp).toBe('yes');
    const checkedIn = await setAttendance(actor, eventId, personId, {
      status: 'present',
      expectedVersion: 1,
      checkIn: true,
    });
    expect(checkedIn.status).toBe('present');
    expect(checkedIn.checked_in_at).toBeInstanceOf(Date);
    await expect(
      checkOutAthlete(actor, eventId, personId, newId(), 2),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const checkedOut = await checkOutAthlete(
      actor,
      eventId,
      personId,
      pickupPersonId,
      2,
    );
    expect(checkedOut.checked_out_at).toBeInstanceOf(Date);
    expect(checkedOut.picked_up_by_person_id).toBe(pickupPersonId);

    const attendanceList = await listEventAttendance(actor, eventId);
    expect(attendanceList.counts).toMatchObject({ yes: 1, present: 1 });
    expect(attendanceList.items).toHaveLength(1);
    expect(attendanceList.items[0]).toMatchObject({
      personId,
      rsvp: 'yes',
      attendance: 'present',
    });
    expect(attendanceList.items[0]?.checkedInAt).toBeInstanceOf(Date);
    expect(attendanceList.items[0]?.checkedOutAt).toBeInstanceOf(Date);
    expect(attendanceList.items[0]?.pickedUpByPersonId).toBe(pickupPersonId);

    const report = await attendanceReport(actor, {
      from: new Date('2026-10-09T00:00:00.000Z'),
      to: new Date('2026-10-11T00:00:00.000Z'),
      teamSeasonId,
    });
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      event_id: eventId,
      rsvp: 'yes',
      status: 'present',
    });

    const gameDay = await coachGameDay(actor, eventId);
    expect(gameDay.roster).toHaveLength(1);
    expect(gameDay.roster[0]).toMatchObject({ personId, suspended: true });
    expect(gameDay.roster[0]?.attendance?.status).toBe('present');
    expect(gameDay.contest?.id).toBe(contestId);

    await withOrg(actor, async (trx) => {
      const audit = await trx
        .selectFrom('audit_log')
        .select('id')
        .where('org_id', '=', orgId)
        .where('action', '=', 'discipline.lineup_blocked')
        .where('entity_id', '=', disciplineId)
        .executeTakeFirst();
      expect(audit).toBeDefined();
      const lineup = await trx
        .selectFrom('lineups')
        .select('id')
        .where('org_id', '=', orgId)
        .where('contest_id', '=', contestId)
        .executeTakeFirst();
      expect(lineup).toBeUndefined();
    });
  });
});
