import { newId } from '@shared/ids';
import { sportProfileSchema } from '@shared/sport/schema';

import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { VersionConflictError } from '../../lib/version-check';
import { assertNotSuspendedForLineup } from '../discipline/service';
import { assertSchedulePermission } from '../scheduling/access';
import { SchedulingRuleError, scopeForEvent } from '../scheduling/events';

async function assertEventAccess(
  trx: OrgTransaction,
  context: OrgContext,
  eventId: string,
  permission: 'attendance.read' | 'attendance.manage' | 'results.manage',
) {
  const event = await trx
    .selectFrom('events')
    .selectAll()
    .where('org_id', '=', context.orgId)
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event)
    throw new SchedulingRuleError('Event not found.', 404, 'NOT_FOUND');
  const teams = await trx
    .selectFrom('event_participants')
    .select('team_season_id')
    .where('org_id', '=', context.orgId)
    .where('event_id', '=', eventId)
    .where('team_season_id', 'is not', null)
    .execute();
  const scope = await scopeForEvent(trx, context.orgId, eventId);
  let allowed = false;
  if (scope) {
    try {
      await assertSchedulePermission(trx, context, permission, scope);
      allowed = true;
    } catch {
      /* Check assigned team scopes for coaches. */
    }
  }
  if (!allowed)
    for (const team of teams) {
      if (!team.team_season_id) continue;
      try {
        await assertSchedulePermission(trx, context, permission, {
          teamSeasonId: team.team_season_id,
        });
        allowed = true;
        break;
      } catch {
        /* Continue through event teams. */
      }
    }
  if (!allowed)
    throw new SchedulingRuleError(
      'You cannot access this event roster.',
      403,
      'FORBIDDEN',
    );
  return {
    event,
    teams: teams.flatMap((team) =>
      team.team_season_id ? [team.team_season_id] : [],
    ),
  };
}

async function personParticipates(
  trx: OrgTransaction,
  orgId: string,
  eventId: string,
  personId: string,
): Promise<boolean> {
  const direct = await trx
    .selectFrom('event_participants')
    .select('id')
    .where('org_id', '=', orgId)
    .where('event_id', '=', eventId)
    .where('person_id', '=', personId)
    .executeTakeFirst();
  if (direct) return true;
  const teamIds = await trx
    .selectFrom('event_participants')
    .select('team_season_id')
    .where('org_id', '=', orgId)
    .where('event_id', '=', eventId)
    .where('team_season_id', 'is not', null)
    .execute();
  const ids = teamIds.flatMap((team) =>
    team.team_season_id ? [team.team_season_id] : [],
  );
  if (!ids.length) return false;
  return Boolean(
    await trx
      .selectFrom('roster_entries')
      .select('id')
      .where('org_id', '=', orgId)
      .where('team_season_id', 'in', ids)
      .where('person_id', '=', personId)
      .where('status', 'in', ['active', 'injured', 'suspended'])
      .executeTakeFirst(),
  );
}

export async function rsvpForChild(
  context: OrgContext,
  eventId: string,
  personId: string,
  rsvp: 'yes' | 'no' | 'maybe' | 'none',
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'attendance.rsvp', {
      personId,
    });
    if (!(await personParticipates(trx, context.orgId, eventId, personId)))
      throw new SchedulingRuleError(
        'This person is not on the event roster.',
        404,
        'NOT_FOUND',
      );
    const existing = await trx
      .selectFrom('attendance')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .where('person_id', '=', personId)
      .executeTakeFirst();
    if (existing)
      return trx
        .updateTable('attendance')
        .set({
          rsvp,
          rsvp_by_account_id: context.actor.accountId,
          version: existing.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', existing.id)
        .where('version', '=', existing.version)
        .returningAll()
        .executeTakeFirstOrThrow();
    return trx
      .insertInto('attendance')
      .values({
        id: newId(),
        org_id: context.orgId,
        event_id: eventId,
        person_id: personId,
        rsvp,
        rsvp_by_account_id: context.actor.accountId,
        status: 'unknown',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function listEventAttendance(
  context: OrgContext,
  eventId: string,
) {
  return withOrg(context, async (trx) => {
    const { event, teams } = await assertEventAccess(
      trx,
      context,
      eventId,
      'attendance.read',
    );
    const direct = await trx
      .selectFrom('event_participants')
      .select('person_id')
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .where('person_id', 'is not', null)
      .execute();
    const personIds = direct.flatMap((row) =>
      row.person_id ? [row.person_id] : [],
    );
    const roster = teams.length
      ? await trx
          .selectFrom('roster_entries')
          .innerJoin('people', (join) =>
            join
              .onRef('people.org_id', '=', 'roster_entries.org_id')
              .onRef('people.id', '=', 'roster_entries.person_id'),
          )
          .select([
            'roster_entries.person_id',
            'roster_entries.team_season_id',
            'roster_entries.status as roster_status',
            'people.first_name',
            'people.last_name',
          ])
          .where('roster_entries.org_id', '=', context.orgId)
          .where('roster_entries.team_season_id', 'in', teams)
          .where('roster_entries.status', 'in', [
            'active',
            'injured',
            'suspended',
          ])
          .execute()
      : [];
    const people = new Map<
      string,
      {
        personId: string;
        teamSeasonId: string | null;
        rosterStatus: string;
        firstName: string;
        lastName: string;
      }
    >();
    for (const row of roster)
      people.set(row.person_id, {
        personId: row.person_id,
        teamSeasonId: row.team_season_id,
        rosterStatus: row.roster_status,
        firstName: row.first_name,
        lastName: row.last_name,
      });
    if (personIds.length) {
      const directPeople = await trx
        .selectFrom('people')
        .select(['id', 'first_name', 'last_name'])
        .where('org_id', '=', context.orgId)
        .where('id', 'in', personIds)
        .execute();
      for (const row of directPeople)
        people.set(row.id, {
          personId: row.id,
          teamSeasonId: null,
          rosterStatus: 'active',
          firstName: row.first_name,
          lastName: row.last_name,
        });
    }
    const attendance = await trx
      .selectFrom('attendance')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .execute();
    const byPerson = new Map(attendance.map((row) => [row.person_id, row]));
    const counts = {
      yes: 0,
      no: 0,
      maybe: 0,
      none: 0,
      present: 0,
      absent: 0,
      late: 0,
      excused: 0,
      unknown: 0,
    };
    const items = [...people.values()]
      .sort(
        (a, b) =>
          a.lastName.localeCompare(b.lastName) ||
          a.firstName.localeCompare(b.firstName),
      )
      .map((person) => {
        const row = byPerson.get(person.personId);
        const rsvp = row?.rsvp ?? 'none';
        const status = row?.status ?? 'unknown';
        counts[rsvp as keyof typeof counts] += 1;
        counts[status as keyof typeof counts] += 1;
        return {
          ...person,
          rsvp,
          attendance: status,
          version: row?.version ?? 0,
          checkedInAt: row?.checked_in_at ?? null,
          checkedOutAt: row?.checked_out_at ?? null,
          pickedUpByPersonId: row?.picked_up_by_person_id ?? null,
        };
      });
    return {
      event: {
        id: event.id,
        title: event.title,
        startsAt: event.starts_at,
        timezone: event.timezone,
      },
      counts,
      items,
    };
  });
}

export async function setAttendance(
  context: OrgContext,
  eventId: string,
  personId: string,
  input: {
    status: 'present' | 'absent' | 'late' | 'excused' | 'unknown';
    expectedVersion: number;
    checkIn?: boolean;
  },
) {
  return withOrg(context, async (trx) => {
    await assertEventAccess(trx, context, eventId, 'attendance.manage');
    if (!(await personParticipates(trx, context.orgId, eventId, personId)))
      throw new SchedulingRuleError(
        'This person is not on the event roster.',
        404,
        'NOT_FOUND',
      );
    const existing = await trx
      .selectFrom('attendance')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .where('person_id', '=', personId)
      .executeTakeFirst();
    if ((existing?.version ?? 0) !== input.expectedVersion)
      throw new VersionConflictError(
        existing ?? { version: 0, eventId, personId },
      );
    const checkedInAt = input.checkIn
      ? new Date()
      : (existing?.checked_in_at ?? null);
    if (existing)
      return trx
        .updateTable('attendance')
        .set({
          status: input.status,
          checked_in_at: checkedInAt,
          checked_in_by: input.checkIn
            ? context.actor.accountId
            : existing.checked_in_by,
          version: existing.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', existing.id)
        .where('version', '=', existing.version)
        .returningAll()
        .executeTakeFirstOrThrow();
    return trx
      .insertInto('attendance')
      .values({
        id: newId(),
        org_id: context.orgId,
        event_id: eventId,
        person_id: personId,
        status: input.status,
        checked_in_at: checkedInAt,
        checked_in_by: input.checkIn ? context.actor.accountId : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function checkOutAthlete(
  context: OrgContext,
  eventId: string,
  personId: string,
  pickupPersonId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    await assertEventAccess(trx, context, eventId, 'attendance.manage');
    const existing = await trx
      .selectFrom('attendance')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .where('person_id', '=', personId)
      .executeTakeFirst();
    if (!existing || !existing.checked_in_at || existing.checked_out_at)
      throw new SchedulingRuleError(
        'Check-out requires an athlete who is currently checked in.',
        409,
        'CONFLICT',
      );
    if (existing.version !== expectedVersion)
      throw new VersionConflictError(existing);
    const authorized = await trx
      .selectFrom('household_members as pickup')
      .innerJoin('household_members as child', (join) =>
        join
          .onRef('child.org_id', '=', 'pickup.org_id')
          .onRef('child.household_id', '=', 'pickup.household_id'),
      )
      .select('pickup.id')
      .where('pickup.org_id', '=', context.orgId)
      .where('pickup.person_id', '=', pickupPersonId)
      .where('pickup.can_pick_up', '=', true)
      .where('child.person_id', '=', personId)
      .executeTakeFirst();
    if (!authorized)
      throw new SchedulingRuleError(
        'Pickup person is not authorized for this athlete.',
        403,
        'FORBIDDEN',
      );
    return trx
      .updateTable('attendance')
      .set({
        checked_out_at: new Date(),
        picked_up_by_person_id: pickupPersonId,
        version: existing.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', existing.id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function saveLineup(
  context: OrgContext,
  contestId: string,
  teamSeasonId: string,
  entries: Array<{ personId: string; position: string; order?: number }>,
  expectedVersion?: number,
) {
  const result = await withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'results.manage', {
      teamSeasonId,
    });
    const contest = await trx
      .selectFrom('contests')
      .innerJoin('events', (join) =>
        join
          .onRef('events.org_id', '=', 'contests.org_id')
          .onRef('events.id', '=', 'contests.event_id'),
      )
      .select([
        'contests.id',
        'events.program_id',
        'events.division_id',
        'events.starts_at',
      ])
      .where('contests.org_id', '=', context.orgId)
      .where('contests.id', '=', contestId)
      .executeTakeFirst();
    if (!contest)
      throw new SchedulingRuleError('Contest not found.', 404, 'NOT_FOUND');
    const team = await trx
      .selectFrom('team_seasons')
      .innerJoin('programs', (join) =>
        join
          .onRef('programs.org_id', '=', 'team_seasons.org_id')
          .onRef('programs.id', '=', 'team_seasons.program_id'),
      )
      .innerJoin('sport_profiles', (join) =>
        join
          .onRef('sport_profiles.org_id', '=', 'programs.org_id')
          .onRef('sport_profiles.id', '=', 'programs.sport_profile_id'),
      )
      .select([
        'team_seasons.program_id',
        'team_seasons.division_id',
        'sport_profiles.profile',
      ])
      .where('team_seasons.org_id', '=', context.orgId)
      .where('team_seasons.id', '=', teamSeasonId)
      .executeTakeFirstOrThrow();
    if (
      team.program_id !== contest.program_id ||
      (contest.division_id && contest.division_id !== team.division_id)
    )
      throw new SchedulingRuleError(
        'Team is not in this contest.',
        403,
        'FORBIDDEN',
      );
    const profile = sportProfileSchema.parse(team.profile);
    const allowedPositions = new Set(
      profile.positions.map((position) => position.key),
    );
    if (
      entries.some((entry) => !allowedPositions.has(entry.position)) ||
      new Set(entries.map((entry) => entry.personId)).size !== entries.length
    )
      throw new SchedulingRuleError(
        'Lineup positions and athletes must be valid and unique.',
      );
    const personIds = entries.map((entry) => entry.personId);
    const roster = personIds.length
      ? await trx
          .selectFrom('roster_entries')
          .select(['person_id', 'status'])
          .where('org_id', '=', context.orgId)
          .where('team_season_id', '=', teamSeasonId)
          .where('person_id', 'in', personIds)
          .execute()
      : [];
    if (
      roster.length !== personIds.length ||
      roster.some((entry) => entry.status !== 'active')
    )
      throw new SchedulingRuleError(
        'Only active roster athletes may enter the lineup.',
        409,
        'CONFLICT',
      );
    let suspensionBlocked = false;
    for (const personId of personIds) {
      try {
        await assertNotSuspendedForLineup(
          trx,
          context,
          personId,
          teamSeasonId,
          contest.starts_at,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'DISCIPLINE_SUSPENSION_ACTIVE'
        ) {
          suspensionBlocked = true;
          break;
        }
        throw error;
      }
    }
    // Let the transaction commit the discipline audit row before surfacing the
    // conflict. Throwing inside withOrg would roll that audit entry back.
    if (suspensionBlocked) return { kind: 'suspension-blocked' as const };
    const existing = await trx
      .selectFrom('lineups')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('contest_id', '=', contestId)
      .where('team_season_id', '=', teamSeasonId)
      .executeTakeFirst();
    if ((existing?.version ?? 0) !== (expectedVersion ?? 0))
      throw new VersionConflictError(
        existing ?? { version: 0, contestId, teamSeasonId },
      );
    const snapshot = entries as unknown as import('../../db/types').Json;
    if (existing)
      return {
        kind: 'saved' as const,
        lineup: await trx
          .updateTable('lineups')
          .set({
            entries: snapshot,
            submitted_by: context.actor.accountId,
            version: existing.version + 1,
          })
          .where('org_id', '=', context.orgId)
          .where('id', '=', existing.id)
          .where('version', '=', existing.version)
          .returningAll()
          .executeTakeFirstOrThrow(),
      };
    return {
      kind: 'saved' as const,
      lineup: await trx
        .insertInto('lineups')
        .values({
          id: newId(),
          org_id: context.orgId,
          contest_id: contestId,
          team_season_id: teamSeasonId,
          entries: snapshot,
          submitted_by: context.actor.accountId,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    };
  });
  if (result.kind === 'suspension-blocked')
    throw new SchedulingRuleError(
      'A suspended athlete cannot be added to this lineup.',
      409,
      'CONFLICT',
    );
  return result.lineup;
}

export async function coachGameDay(context: OrgContext, eventId: string) {
  return withOrg(context, async (trx) => {
    const { event, teams } = await assertEventAccess(
      trx,
      context,
      eventId,
      'results.manage',
    );
    const roster = teams.length
      ? await trx
          .selectFrom('roster_entries')
          .innerJoin('people', (join) =>
            join
              .onRef('people.org_id', '=', 'roster_entries.org_id')
              .onRef('people.id', '=', 'roster_entries.person_id'),
          )
          .select([
            'roster_entries.person_id',
            'roster_entries.team_season_id',
            'roster_entries.status as roster_status',
            'roster_entries.positions',
            'people.first_name',
            'people.last_name',
            'people.date_of_birth',
          ])
          .where('roster_entries.org_id', '=', context.orgId)
          .where('roster_entries.team_season_id', 'in', teams)
          .where('roster_entries.status', 'in', [
            'active',
            'injured',
            'suspended',
          ])
          .orderBy('people.last_name')
          .orderBy('people.first_name')
          .execute()
      : [];
    const ids = roster.map((row) => row.person_id);
    const medical = ids.length
      ? await trx
          .selectFrom('medical_profiles')
          .select(['person_id', 'allergy_flags'])
          .where('org_id', '=', context.orgId)
          .where('person_id', 'in', ids)
          .execute()
      : [];
    const medicalByPerson = new Map(
      medical.map((row) => [row.person_id, row.allergy_flags]),
    );
    const contacts = ids.length
      ? await trx
          .selectFrom('emergency_contacts')
          .select([
            'person_id',
            'name',
            'relationship',
            'phone_e164',
            'alt_phone_e164',
            'priority',
          ])
          .where('org_id', '=', context.orgId)
          .where('person_id', 'in', ids)
          .orderBy('priority')
          .execute()
      : [];
    const contactByPerson = new Map<string, typeof contacts>();
    for (const contact of contacts)
      contactByPerson.set(contact.person_id, [
        ...(contactByPerson.get(contact.person_id) ?? []),
        contact,
      ]);
    const discipline = ids.length
      ? await trx
          .selectFrom('discipline_records')
          .select([
            'person_id',
            'team_season_id',
            'suspension_games',
            'games_served',
            'status',
          ])
          .where('org_id', '=', context.orgId)
          .where('person_id', 'in', ids)
          .where('status', '=', 'active')
          .execute()
      : [];
    const activeSuspensions = new Set(
      discipline
        .filter(
          (record) =>
            record.suspension_games !== null &&
            record.games_served < record.suspension_games,
        )
        .map((record) => record.person_id),
    );
    const attendance = await trx
      .selectFrom('attendance')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .execute();
    const attendanceByPerson = new Map(
      attendance.map((row) => [row.person_id, row]),
    );
    const contest = await trx
      .selectFrom('contests')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    const lineups = contest
      ? await trx
          .selectFrom('lineups')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('contest_id', '=', contest.id)
          .where('team_season_id', 'in', teams)
          .execute()
      : [];
    const program = event.program_id
      ? await trx
          .selectFrom('programs')
          .innerJoin('sport_profiles', (join) =>
            join
              .onRef('sport_profiles.org_id', '=', 'programs.org_id')
              .onRef('sport_profiles.id', '=', 'programs.sport_profile_id'),
          )
          .select('sport_profiles.profile')
          .where('programs.org_id', '=', context.orgId)
          .where('programs.id', '=', event.program_id)
          .executeTakeFirst()
      : null;
    const profile = program ? sportProfileSchema.parse(program.profile) : null;
    return {
      event: {
        id: event.id,
        title: event.title,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        timezone: event.timezone,
        arrivalMinutesBefore: event.arrival_minutes_before,
      },
      roster: roster.map((person) => ({
        personId: person.person_id,
        teamSeasonId: person.team_season_id,
        firstName: person.first_name,
        lastName: person.last_name,
        positions: person.positions,
        injured: person.roster_status === 'injured',
        suspended: activeSuspensions.has(person.person_id),
        allergyFlags: medicalByPerson.get(person.person_id) ?? [],
        emergencyContacts: (contactByPerson.get(person.person_id) ?? []).map(
          (contact) => ({
            name: contact.name,
            relationship: contact.relationship,
            phone: contact.phone_e164,
            alternatePhone: contact.alt_phone_e164,
          }),
        ),
        attendance: attendanceByPerson.get(person.person_id) ?? null,
      })),
      contest: contest
        ? {
            id: contest.id,
            status: contest.status,
            version: contest.version,
            format: contest.format,
            score: await trx
              .selectFrom('contest_results')
              .innerJoin('contest_participants', (join) =>
                join
                  .onRef(
                    'contest_participants.org_id',
                    '=',
                    'contest_results.org_id',
                  )
                  .onRef(
                    'contest_participants.id',
                    '=',
                    'contest_results.contest_participant_id',
                  ),
              )
              .select([
                'contest_participants.team_season_id',
                'contest_results.score',
                'contest_results.score_detail',
              ])
              .where('contest_results.org_id', '=', context.orgId)
              .where('contest_participants.contest_id', '=', contest.id)
              .execute(),
          }
        : null,
      lineups,
      sportProfile: profile
        ? {
            positions: profile.positions,
            minimumPlayRule: profile.minimumPlayRule ?? null,
          }
        : null,
    };
  });
}

export async function attendanceReport(
  context: OrgContext,
  input: { from: Date; to: Date; teamSeasonId?: string },
) {
  return withOrg(context, async (trx) => {
    if (input.teamSeasonId)
      await assertSchedulePermission(trx, context, 'attendance.read', {
        teamSeasonId: input.teamSeasonId,
      });
    else await assertSchedulePermission(trx, context, 'attendance.read');
    let query = trx
      .selectFrom('attendance')
      .innerJoin('events', (join) =>
        join
          .onRef('events.org_id', '=', 'attendance.org_id')
          .onRef('events.id', '=', 'attendance.event_id'),
      )
      .innerJoin('people', (join) =>
        join
          .onRef('people.org_id', '=', 'attendance.org_id')
          .onRef('people.id', '=', 'attendance.person_id'),
      )
      .select([
        'attendance.event_id',
        'attendance.person_id',
        'events.title',
        'events.starts_at',
        'people.first_name',
        'people.last_name',
        'attendance.rsvp',
        'attendance.status',
        'attendance.checked_in_at',
        'attendance.checked_out_at',
      ])
      .where('attendance.org_id', '=', context.orgId)
      .where('events.starts_at', '>=', input.from)
      .where('events.starts_at', '<', input.to);
    if (input.teamSeasonId)
      query = query
        .innerJoin('event_participants', (join) =>
          join
            .onRef('event_participants.org_id', '=', 'events.org_id')
            .onRef('event_participants.event_id', '=', 'events.id'),
        )
        .where('event_participants.team_season_id', '=', input.teamSeasonId);
    return query.orderBy('events.starts_at', 'desc').execute();
  });
}
