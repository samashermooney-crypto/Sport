import { createHash, randomBytes } from 'node:crypto';

import { newId } from '@shared/ids';
import { expand } from '@shared/recurrence';
import { sql } from 'kysely';

import type { Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { VersionConflictError } from '../../lib/version-check';
import { appendAuditEvent } from '../audit/service';

import { assertSchedulePermission } from './access';
import type { ResourceScope } from './access';
import type {
  EventCreateWithOverrideInput,
  EventUpdateInput,
  GeneratorConstraints,
} from './schema';

export type ScheduleConflict = {
  kind: 'space' | 'blackout' | 'availability' | 'team' | 'coach' | 'official';
  eventId: string | null;
  message: string;
  overridable: boolean;
};

export class SchedulingRuleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503 = 400,
    readonly code = 'SCHEDULE_INVALID',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function safeNotes(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function localDateInTimezone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: 'year' | 'month' | 'day') =>
    parts.find((item) => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new RangeError('Invalid timezone date');
  return `${year}-${month}-${day}`;
}

function iso(value: Date): string {
  return value.toISOString();
}

function eventResponse(row: {
  id: string;
  org_id: string;
  title: string;
  kind: string;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  status: string;
  status_reason: string | null;
  published: boolean;
  program_id: string | null;
  division_id: string | null;
  space_id: string | null;
  location_text: string | null;
  notes_html: string | null;
  arrival_minutes_before: number;
  version: number;
}) {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    kind: row.kind,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    timezone: row.timezone,
    status: row.status,
    statusReason: row.status_reason,
    published: row.published,
    programId: row.program_id,
    divisionId: row.division_id,
    spaceId: row.space_id,
    locationText: row.location_text,
    notesHtml: row.notes_html,
    arrivalMinutesBefore: row.arrival_minutes_before,
    version: row.version,
  };
}

export async function scopeForEvent(
  trx: OrgTransaction,
  orgId: string,
  eventId: string,
): Promise<ResourceScope | null> {
  const event = await trx
    .selectFrom('events')
    .select(['program_id', 'division_id'])
    .where('org_id', '=', orgId)
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event) return null;
  const participant = await trx
    .selectFrom('event_participants')
    .select('team_season_id')
    .where('org_id', '=', orgId)
    .where('event_id', '=', eventId)
    .where('team_season_id', 'is not', null)
    .executeTakeFirst();
  return {
    ...(event.program_id ? { programId: event.program_id } : {}),
    ...(event.division_id ? { divisionId: event.division_id } : {}),
    ...(participant?.team_season_id
      ? { teamSeasonId: participant.team_season_id }
      : {}),
  };
}

export async function resolveTimezoneAndBuffer(
  trx: OrgTransaction,
  orgId: string,
  spaceId: string | null | undefined,
  programId: string | null | undefined,
): Promise<{ timezone: string; bufferMinutes: number }> {
  const org = await trx
    .selectFrom('organizations')
    .select('timezone')
    .where('id', '=', orgId)
    .executeTakeFirst();
  if (!org)
    throw new SchedulingRuleError('Organization not found', 404, 'NOT_FOUND');
  let timezone = org.timezone;
  if (spaceId) {
    const facility = await trx
      .selectFrom('spaces')
      .innerJoin('facilities', (join) =>
        join
          .onRef('facilities.id', '=', 'spaces.facility_id')
          .onRef('facilities.org_id', '=', 'spaces.org_id'),
      )
      .select(['spaces.id', 'spaces.archived_at', 'facilities.timezone'])
      .where('spaces.org_id', '=', orgId)
      .where('spaces.id', '=', spaceId)
      .executeTakeFirst();
    if (!facility || facility.archived_at)
      throw new SchedulingRuleError('Space not found', 404, 'NOT_FOUND');
    timezone = facility.timezone ?? timezone;
  }
  let bufferMinutes = 0;
  if (programId) {
    const profile = await trx
      .selectFrom('programs')
      .innerJoin('sport_profiles', (join) =>
        join
          .onRef('sport_profiles.org_id', '=', 'programs.org_id')
          .onRef('sport_profiles.id', '=', 'programs.sport_profile_id'),
      )
      .select('sport_profiles.profile')
      .where('programs.org_id', '=', orgId)
      .where('programs.id', '=', programId)
      .executeTakeFirst();
    if (!profile)
      throw new SchedulingRuleError('Program not found', 404, 'NOT_FOUND');
    const raw = profile.profile as {
      defaultDurations?: { bufferMinutes?: unknown };
    };
    const value = raw.defaultDurations?.bufferMinutes;
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 240
    )
      bufferMinutes = value;
  }
  return { timezone, bufferMinutes };
}

export async function leafSpaceIds(
  trx: OrgTransaction,
  orgId: string,
  spaceId: string,
): Promise<string[]> {
  const result = await sql<{ id: string }>`
    WITH RECURSIVE descendants AS (
      SELECT id FROM spaces WHERE org_id = ${orgId} AND id = ${spaceId}
      UNION ALL
      SELECT child.id FROM spaces child
      JOIN descendants parent ON child.parent_space_id = parent.id
      WHERE child.org_id = ${orgId}
    )
    SELECT d.id FROM descendants d
    WHERE NOT EXISTS (
      SELECT 1 FROM spaces child WHERE child.org_id = ${orgId} AND child.parent_space_id = d.id
    )
  `.execute(trx);
  return result.rows.map((row) => row.id);
}

export async function insertSpaceBooking(
  trx: OrgTransaction,
  orgId: string,
  spaceId: string,
  startsAt: Date,
  endsAt: Date,
  bufferMinutes: number,
  eventId: string,
): Promise<void> {
  const leaves = await leafSpaceIds(trx, orgId, spaceId);
  if (!leaves.length)
    throw new SchedulingRuleError('Space not found', 404, 'NOT_FOUND');
  const bookingGroupId = newId();
  const bufferedEnd = new Date(endsAt.getTime() + bufferMinutes * 60_000);
  for (const leafSpaceId of leaves) {
    await trx
      .insertInto('space_bookings')
      .values({
        id: newId(),
        org_id: orgId,
        booking_group_id: bookingGroupId,
        leaf_space_id: leafSpaceId,
        during: sql`tstzrange(${startsAt.toISOString()}::timestamptz, ${bufferedEnd.toISOString()}::timestamptz, '[)')`,
        event_id: eventId,
        allocation_id: null,
      })
      .execute();
  }
}

export async function queueChangeBatch(
  trx: OrgTransaction,
  context: OrgContext,
  event: { id: string; title: string; startsAt: string; endsAt: string },
  recipients: readonly string[],
  change: 'created' | 'updated' | 'canceled' | 'postponed',
  notificationType:
    'schedule.changed' | 'safety.emergency' = 'schedule.changed',
): Promise<void> {
  const uniqueRecipients = [...new Set(recipients)];
  for (const recipientAccountId of uniqueRecipients) {
    const existing = await trx
      .selectFrom('schedule_change_batches')
      .select(['id', 'changes', 'notification_type'])
      .where('org_id', '=', context.orgId)
      .where('recipient_account_id', '=', recipientAccountId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    const item = {
      eventId: event.id,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      change,
    };
    if (existing) {
      const changes = Array.isArray(existing.changes)
        ? (existing.changes as Array<Record<string, unknown>>)
        : [];
      const next = [
        ...changes.filter((value) => value.eventId !== event.id),
        item,
      ];
      await trx
        .updateTable('schedule_change_batches')
        .set({
          changes: JSON.stringify(next) as unknown as Json,
          notification_type:
            notificationType === 'safety.emergency' ||
            existing.notification_type === 'safety.emergency'
              ? 'safety.emergency'
              : 'schedule.changed',
          ...(notificationType === 'safety.emergency'
            ? { emit_after: new Date() }
            : {}),
          version: sql`version + 1`,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', existing.id)
        .execute();
    } else {
      await trx
        .insertInto('schedule_change_batches')
        .values({
          id: newId(),
          org_id: context.orgId,
          recipient_account_id: recipientAccountId,
          created_by: context.actor.accountId,
          changes: JSON.stringify([item]) as unknown as Json,
          emit_after:
            notificationType === 'safety.emergency'
              ? new Date()
              : new Date(Date.now() + 15 * 60_000),
          notification_type: notificationType,
        })
        .execute();
    }
  }
}

export async function eventRecipients(
  trx: OrgTransaction,
  orgId: string,
  participants: EventCreateWithOverrideInput['participants'],
  eventId?: string,
): Promise<string[]> {
  const teamIds = participants
    .filter((item) => item.type === 'team')
    .map((item) => item.id);
  const personIds = participants
    .filter((item) => item.type === 'person')
    .map((item) => item.id);
  if (teamIds.length) {
    const roster = await trx
      .selectFrom('roster_entries')
      .select('person_id')
      .where('org_id', '=', orgId)
      .where('team_season_id', 'in', teamIds)
      .where('status', 'in', ['active', 'injured', 'suspended'])
      .execute();
    personIds.push(...roster.map((row) => row.person_id));
    const coaches = await trx
      .selectFrom('team_staff')
      .select('person_id')
      .where('org_id', '=', orgId)
      .where('team_season_id', 'in', teamIds)
      .where('status', '=', 'active')
      .execute();
    personIds.push(...coaches.map((row) => row.person_id));
  }
  if (eventId) {
    const officials = await trx
      .selectFrom('contests')
      .innerJoin('official_assignments', (join) =>
        join
          .onRef('official_assignments.org_id', '=', 'contests.org_id')
          .onRef('official_assignments.contest_id', '=', 'contests.id'),
      )
      .select('official_assignments.person_id')
      .where('contests.org_id', '=', orgId)
      .where('contests.event_id', '=', eventId)
      .where('official_assignments.status', 'not in', ['declined', 'canceled'])
      .execute();
    personIds.push(...officials.map((row) => row.person_id));
  }
  if (!personIds.length) return [];
  const links = await trx
    .selectFrom('person_account_links')
    .select('account_id')
    .where('org_id', '=', orgId)
    .where('person_id', 'in', [...new Set(personIds)])
    .where('relationship', 'in', ['guardian', 'self'])
    .where('verified_at', 'is not', null)
    .where('revoked_at', 'is', null)
    .execute();
  return [...new Set(links.map((row) => row.account_id))];
}

export async function listEvents(
  context: OrgContext,
  query: {
    from: Date;
    to: Date;
    programId?: string;
    teamSeasonId?: string;
    includeDrafts?: boolean;
  },
): Promise<ReturnType<typeof eventResponse>[]> {
  if (
    query.from >= query.to ||
    query.to.getTime() - query.from.getTime() > 370 * 86_400_000
  )
    throw new SchedulingRuleError('The date range must be at most 370 days');
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.read', {
      ...(query.programId ? { programId: query.programId } : {}),
      ...(query.teamSeasonId ? { teamSeasonId: query.teamSeasonId } : {}),
    });
    let events = trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('starts_at', '<', query.to)
      .where('ends_at', '>', query.from)
      .where('status', '!=', 'canceled')
      .orderBy('starts_at')
      .limit(1000);
    if (query.programId)
      events = events.where('program_id', '=', query.programId);
    if (!query.includeDrafts) events = events.where('published', '=', true);
    const rows = await events.execute();
    let visible = rows;
    if (query.teamSeasonId) {
      const refs = await trx
        .selectFrom('event_participants')
        .select('event_id')
        .where('org_id', '=', context.orgId)
        .where('team_season_id', '=', query.teamSeasonId)
        .execute();
      const ids = new Set(refs.map((row) => row.event_id));
      visible = rows.filter((row) => ids.has(row.id));
    }
    return visible.map(eventResponse);
  });
}

export async function getEvent(
  context: OrgContext,
  eventId: string,
  permission:
    | 'schedule.read'
    | 'schedule.manage'
    | 'attendance.read'
    | 'results.read' = 'schedule.read',
) {
  return withOrg(context, async (trx) => {
    const scope = await scopeForEvent(trx, context.orgId, eventId);
    if (!scope)
      throw new SchedulingRuleError('Event not found', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, permission, scope);
    const row = await trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    return eventResponse(row);
  });
}

export async function getConflicts(
  trx: OrgTransaction,
  context: OrgContext,
  input: EventCreateWithOverrideInput,
  excludeEventId?: string | readonly string[],
): Promise<ScheduleConflict[]> {
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  const excludedIds =
    typeof excludeEventId === 'string'
      ? [excludeEventId]
      : excludeEventId
        ? [...excludeEventId]
        : [];
  if (
    !Number.isFinite(startsAt.valueOf()) ||
    !Number.isFinite(endsAt.valueOf()) ||
    startsAt >= endsAt
  )
    throw new SchedulingRuleError('Event end must be after its start');
  const conflicts: ScheduleConflict[] = [];
  if (input.spaceId) {
    const leaves = await leafSpaceIds(trx, context.orgId, input.spaceId);
    if (!leaves.length)
      throw new SchedulingRuleError('Space not found', 404, 'NOT_FOUND');
    const spaceTree = await trx
      .selectFrom('spaces')
      .select(['id', 'parent_space_id'])
      .where('org_id', '=', context.orgId)
      .execute();
    const byId = new Map(spaceTree.map((space) => [space.id, space]));
    const relevantSpaceIds = new Set<string>([input.spaceId, ...leaves]);
    for (const leafId of leaves) {
      let parentId = byId.get(leafId)?.parent_space_id ?? null;
      while (parentId) {
        relevantSpaceIds.add(parentId);
        parentId = byId.get(parentId)?.parent_space_id ?? null;
      }
    }
    const row = await trx
      .selectFrom('spaces')
      .innerJoin('facilities', (join) =>
        join
          .onRef('facilities.org_id', '=', 'spaces.org_id')
          .onRef('facilities.id', '=', 'spaces.facility_id'),
      )
      .select(['facilities.id as facility_id', 'spaces.id as space_id'])
      .where('spaces.org_id', '=', context.orgId)
      .where('spaces.id', '=', input.spaceId)
      .executeTakeFirstOrThrow();
    const { bufferMinutes } = await resolveTimezoneAndBuffer(
      trx,
      context.orgId,
      input.spaceId,
      input.programId,
    );
    const bufferedEnd = new Date(endsAt.getTime() + bufferMinutes * 60_000);
    const bookings = await trx
      .selectFrom('space_bookings')
      .select('event_id')
      .where('org_id', '=', context.orgId)
      .where('leaf_space_id', 'in', leaves)
      .where(
        sql<boolean>`during && tstzrange(${startsAt.toISOString()}::timestamptz, ${bufferedEnd.toISOString()}::timestamptz, '[)')`,
      )
      .execute();
    const booking = bookings.find(
      (row) => !row.event_id || !excludedIds.includes(row.event_id),
    );
    if (booking)
      conflicts.push({
        kind: 'space',
        eventId: booking.event_id,
        message: 'This space is already booked.',
        overridable: false,
      });

    const blocked = await trx
      .selectFrom('space_blackouts')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('starts_at', '<', bufferedEnd)
      .where('ends_at', '>', startsAt)
      .where((eb) =>
        eb.or([
          eb('space_id', 'in', [...relevantSpaceIds]),
          eb('facility_id', '=', row.facility_id),
        ]),
      )
      .executeTakeFirst();
    if (blocked)
      conflicts.push({
        kind: 'blackout',
        eventId: null,
        message: 'The space or facility is blacked out for this time.',
        overridable: false,
      });

    const closure = await trx
      .selectFrom('closures')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('starts_at', '<', bufferedEnd)
      .where('ends_at', '>', startsAt)
      .where((eb) =>
        eb.or([
          eb('scope_type', '=', 'org'),
          eb.and([
            eb('scope_type', '=', 'space'),
            eb('scope_id', 'in', [...relevantSpaceIds]),
          ]),
          eb.and([
            eb('scope_type', '=', 'facility'),
            eb('scope_id', '=', row.facility_id),
          ]),
        ]),
      )
      .executeTakeFirst();
    if (closure)
      conflicts.push({
        kind: 'blackout',
        eventId: null,
        message: 'The facility or space is closed for this time.',
        overridable: false,
      });

    const availability = await trx
      .selectFrom('space_availability')
      .select(['recurrence', 'start_time', 'end_time', 'starts_on', 'ends_on'])
      .where('org_id', '=', context.orgId)
      .where('space_id', 'in', [...relevantSpaceIds])
      .execute();
    if (availability.length) {
      const { timezone } = await resolveTimezoneAndBuffer(
        trx,
        context.orgId,
        input.spaceId,
        input.programId,
      );
      const eventDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
      }).format(startsAt);
      const fits = availability.some((window) => {
        try {
          if (eventDate < window.starts_on.toISOString().slice(0, 10))
            return false;
          if (eventDate > window.ends_on.toISOString().slice(0, 10))
            return false;
          const recurrence =
            window.recurrence as unknown as import('@shared/recurrence').Recurrence;
          const duration =
            (Date.parse(`1970-01-01T${window.end_time}Z`) -
              Date.parse(`1970-01-01T${window.start_time}Z`)) /
            60_000;
          const occurrences = expand(
            {
              recurrence,
              startTime: window.start_time,
              durationMinutes: duration,
              timezone,
            },
            eventDate,
            eventDate,
          );
          return occurrences.some(
            (occurrence) =>
              new Date(occurrence.startsAt) <= startsAt &&
              new Date(occurrence.endsAt).getTime() >= bufferedEnd.getTime(),
          );
        } catch {
          return false;
        }
      });
      if (!fits)
        conflicts.push({
          kind: 'availability',
          eventId: null,
          message:
            'The requested time is outside the space availability window.',
          overridable: false,
        });
    }
  } else {
    const orgClosure = await trx
      .selectFrom('closures')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('scope_type', '=', 'org')
      .where('starts_at', '<', endsAt)
      .where('ends_at', '>', startsAt)
      .executeTakeFirst();
    if (orgClosure)
      conflicts.push({
        kind: 'blackout',
        eventId: null,
        message: 'The organization is closed for this time.',
        overridable: false,
      });
  }

  const teamIds = input.participants
    .filter((participant) => participant.type === 'team')
    .map((participant) => participant.id);
  if (teamIds.length) {
    const overlaps = await trx
      .selectFrom('events')
      .innerJoin('event_participants', (join) =>
        join
          .onRef('event_participants.org_id', '=', 'events.org_id')
          .onRef('event_participants.event_id', '=', 'events.id'),
      )
      .select(['events.id as event_id'])
      .where('events.org_id', '=', context.orgId)
      .where('event_participants.team_season_id', 'in', teamIds)
      .where('events.starts_at', '<', endsAt)
      .where('events.ends_at', '>', startsAt)
      .where('events.status', 'not in', ['canceled', 'completed'])
      .$if(excludedIds.length > 0, (qb) =>
        qb.where('events.id', 'not in', excludedIds),
      )
      .execute();
    if (overlaps.length) {
      conflicts.push({
        kind: 'team',
        eventId: overlaps[0]?.event_id ?? null,
        message: 'A team has another overlapping event.',
        overridable: true,
      });
    }

    const proposedStaff = await trx
      .selectFrom('team_staff')
      .select('person_id')
      .where('org_id', '=', context.orgId)
      .where('team_season_id', 'in', teamIds)
      .where('status', '=', 'active')
      .where('role', 'in', [
        'head_coach',
        'assistant_coach',
        'team_manager',
        'trainer',
      ])
      .execute();
    const staffIds = [...new Set(proposedStaff.map((row) => row.person_id))];
    if (staffIds.length) {
      const otherTeams = await trx
        .selectFrom('team_staff')
        .select('team_season_id')
        .where('org_id', '=', context.orgId)
        .where('person_id', 'in', staffIds)
        .where('team_season_id', 'not in', teamIds)
        .where('status', '=', 'active')
        .execute();
      const otherTeamIds = [
        ...new Set(otherTeams.map((row) => row.team_season_id)),
      ];
      if (otherTeamIds.length) {
        const coachOverlap = await trx
          .selectFrom('events')
          .innerJoin('event_participants', (join) =>
            join
              .onRef('event_participants.org_id', '=', 'events.org_id')
              .onRef('event_participants.event_id', '=', 'events.id'),
          )
          .select('events.id')
          .where('events.org_id', '=', context.orgId)
          .where('event_participants.team_season_id', 'in', otherTeamIds)
          .where('events.starts_at', '<', endsAt)
          .where('events.ends_at', '>', startsAt)
          .where('events.status', 'not in', ['canceled', 'completed'])
          .$if(excludedIds.length > 0, (qb) =>
            qb.where('events.id', 'not in', excludedIds),
          )
          .executeTakeFirst();
        if (coachOverlap)
          conflicts.push({
            kind: 'coach',
            eventId: coachOverlap.id,
            message: 'A coach is assigned to another overlapping event.',
            overridable: true,
          });
      }
    }
  }
  return conflicts;
}

async function insertParticipants(
  trx: OrgTransaction,
  orgId: string,
  eventId: string,
  participants: EventCreateWithOverrideInput['participants'],
): Promise<void> {
  for (const item of participants) {
    await trx
      .insertInto('event_participants')
      .values({
        id: newId(),
        org_id: orgId,
        event_id: eventId,
        team_season_id: item.type === 'team' ? item.id : null,
        external_team_id: item.type === 'external_team' ? item.id : null,
        person_id: item.type === 'person' ? item.id : null,
        division_id: item.type === 'division' ? item.id : null,
        side: item.side,
      })
      .execute();
  }
}

export async function createEvent(
  context: OrgContext,
  input: EventCreateWithOverrideInput,
): Promise<ReturnType<typeof eventResponse>> {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      ...(input.programId ? { programId: input.programId } : {}),
      ...(input.divisionId ? { divisionId: input.divisionId } : {}),
    });
    const conflicts = await getConflicts(trx, context, input);
    const hard = conflicts.filter((conflict) => !conflict.overridable);
    const soft = conflicts.filter((conflict) => conflict.overridable);
    if (hard.length || (soft.length && !input.overrideReason))
      throw new SchedulingRuleError(
        'The event conflicts with the schedule.',
        409,
        'SCHEDULE_CONFLICT',
        { conflicts },
      );

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const { timezone, bufferMinutes } = await resolveTimezoneAndBuffer(
      trx,
      context.orgId,
      input.spaceId,
      input.programId,
    );
    const id = newId();
    await trx
      .insertInto('events')
      .values({
        id,
        org_id: context.orgId,
        program_id: input.programId ?? null,
        division_id: input.divisionId ?? null,
        kind: input.kind,
        title: input.title,
        starts_at: startsAt,
        ends_at: endsAt,
        timezone,
        space_id: input.spaceId ?? null,
        location_text: input.locationText ?? null,
        notes_html: safeNotes(input.notesHtml),
        arrival_minutes_before: input.arrivalMinutesBefore,
        published: input.published,
      })
      .execute();
    await insertParticipants(trx, context.orgId, id, input.participants);
    if (input.spaceId)
      await insertSpaceBooking(
        trx,
        context.orgId,
        input.spaceId,
        startsAt,
        endsAt,
        bufferMinutes,
        id,
      );
    await appendAuditEvent(trx, context, {
      action: 'schedule.event.create',
      entityType: 'event',
      entityId: id,
      changes: soft.length
        ? {
            conflictOverride: {
              tier: 'internal',
              after: input.overrideReason ?? '',
            },
          }
        : {},
    });
    if (input.published) {
      const recipients = await eventRecipients(
        trx,
        context.orgId,
        input.participants,
      );
      await queueChangeBatch(
        trx,
        context,
        {
          id,
          title: input.title,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
        recipients,
        'created',
      );
    }
    return eventResponse(
      await trx
        .selectFrom('events')
        .selectAll()
        .where('org_id', '=', context.orgId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
  });
}

export async function publishEvent(
  context: OrgContext,
  eventId: string,
  expectedVersion: number,
): Promise<ReturnType<typeof eventResponse>> {
  return withOrg(context, async (trx) => {
    const scope = await scopeForEvent(trx, context.orgId, eventId);
    if (!scope)
      throw new SchedulingRuleError('Event not found', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'schedule.manage', scope);
    const current = await trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    if (current.version !== expectedVersion)
      throw new VersionConflictError(current);
    const next = await trx
      .updateTable('events')
      .set({ published: true, version: current.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', eventId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!next) throw new VersionConflictError(current);
    const participants = await trx
      .selectFrom('event_participants')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .execute();
    const recipientParticipants = participants.flatMap((item) => [
      ...(item.team_season_id
        ? [
            {
              type: 'team' as const,
              id: item.team_season_id,
              side: item.side as 'home' | 'away' | 'none',
            },
          ]
        : []),
      ...(item.person_id
        ? [
            {
              type: 'person' as const,
              id: item.person_id,
              side: item.side as 'home' | 'away' | 'none',
            },
          ]
        : []),
    ]);
    const recipients = await eventRecipients(
      trx,
      context.orgId,
      recipientParticipants,
    );
    await queueChangeBatch(
      trx,
      context,
      {
        id: next.id,
        title: next.title,
        startsAt: next.starts_at.toISOString(),
        endsAt: next.ends_at.toISOString(),
      },
      recipients,
      'created',
    );
    await appendAuditEvent(trx, context, {
      action: 'schedule.event.publish',
      entityType: 'event',
      entityId: eventId,
    });
    return eventResponse(next);
  });
}

export async function updateEvent(
  context: OrgContext,
  eventId: string,
  input: EventUpdateInput,
): Promise<ReturnType<typeof eventResponse>> {
  return withOrg(context, async (trx) => {
    const scope = await scopeForEvent(trx, context.orgId, eventId);
    if (!scope)
      throw new SchedulingRuleError('Event not found', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'schedule.manage', scope);
    const current = await trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    if (current.version !== input.expectedVersion)
      throw new VersionConflictError(current);
    const existingParticipants = await trx
      .selectFrom('event_participants')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .execute();
    const participants =
      input.participants ??
      existingParticipants.flatMap((row) => [
        ...(row.team_season_id
          ? [
              {
                type: 'team' as const,
                id: row.team_season_id,
                side: row.side as 'home' | 'away' | 'none',
              },
            ]
          : []),
        ...(row.external_team_id
          ? [
              {
                type: 'external_team' as const,
                id: row.external_team_id,
                side: row.side as 'home' | 'away' | 'none',
              },
            ]
          : []),
        ...(row.person_id
          ? [
              {
                type: 'person' as const,
                id: row.person_id,
                side: row.side as 'home' | 'away' | 'none',
              },
            ]
          : []),
        ...(row.division_id
          ? [
              {
                type: 'division' as const,
                id: row.division_id,
                side: row.side as 'home' | 'away' | 'none',
              },
            ]
          : []),
      ]);
    const merged: EventCreateWithOverrideInput = {
      kind:
        input.kind ?? (current.kind as EventCreateWithOverrideInput['kind']),
      title: input.title ?? current.title,
      startsAt: input.startsAt ?? current.starts_at.toISOString(),
      endsAt: input.endsAt ?? current.ends_at.toISOString(),
      ...((input.timezone ?? current.timezone)
        ? { timezone: input.timezone ?? current.timezone }
        : {}),
      programId:
        input.programId !== undefined ? input.programId : current.program_id,
      divisionId:
        input.divisionId !== undefined ? input.divisionId : current.division_id,
      spaceId: input.spaceId !== undefined ? input.spaceId : current.space_id,
      locationText:
        input.locationText !== undefined
          ? input.locationText
          : current.location_text,
      notesHtml:
        input.notesHtml !== undefined ? input.notesHtml : current.notes_html,
      arrivalMinutesBefore:
        input.arrivalMinutesBefore ?? current.arrival_minutes_before,
      participants,
      published: input.published ?? current.published,
      ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
    };
    const conflicts = await getConflicts(trx, context, merged, eventId);
    const hard = conflicts.filter((conflict) => !conflict.overridable);
    const soft = conflicts.filter((conflict) => conflict.overridable);
    if (hard.length || (soft.length && !input.overrideReason))
      throw new SchedulingRuleError(
        'The event conflicts with the schedule.',
        409,
        'SCHEDULE_CONFLICT',
        { conflicts },
      );
    await trx
      .deleteFrom('space_bookings')
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .execute();
    await trx
      .deleteFrom('event_participants')
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .execute();
    const startsAt = new Date(merged.startsAt);
    const endsAt = new Date(merged.endsAt);
    const { timezone, bufferMinutes } = await resolveTimezoneAndBuffer(
      trx,
      context.orgId,
      merged.spaceId,
      merged.programId,
    );
    const eventTimezone = merged.spaceId
      ? timezone
      : (input.timezone ?? current.timezone);
    const updated = await trx
      .updateTable('events')
      .set({
        program_id: merged.programId ?? null,
        division_id: merged.divisionId ?? null,
        kind: merged.kind,
        title: merged.title,
        starts_at: startsAt,
        ends_at: endsAt,
        timezone: eventTimezone,
        space_id: merged.spaceId ?? null,
        location_text: merged.locationText ?? null,
        notes_html: safeNotes(merged.notesHtml),
        arrival_minutes_before: merged.arrivalMinutesBefore,
        published: merged.published,
        version: current.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', eventId)
      .where('version', '=', input.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(current);
    await insertParticipants(trx, context.orgId, eventId, merged.participants);
    if (merged.spaceId)
      await insertSpaceBooking(
        trx,
        context.orgId,
        merged.spaceId,
        startsAt,
        endsAt,
        bufferMinutes,
        eventId,
      );
    await appendAuditEvent(trx, context, {
      action: 'schedule.event.update',
      entityType: 'event',
      entityId: eventId,
      changes: soft.length
        ? {
            conflictOverride: {
              tier: 'internal',
              after: merged.overrideReason ?? '',
            },
          }
        : {},
    });
    if (current.published || updated.published) {
      const recipients = await eventRecipients(
        trx,
        context.orgId,
        merged.participants,
      );
      await queueChangeBatch(
        trx,
        context,
        {
          id: eventId,
          title: updated.title,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
        recipients,
        'updated',
      );
    }
    return eventResponse(updated);
  });
}

export async function createEventSeries(
  context: OrgContext,
  input: import('./schema').EventSeriesCreateInput,
): Promise<{ seriesId: string; eventIds: string[] }> {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      ...(input.template.programId
        ? { programId: input.template.programId }
        : {}),
      ...(input.template.divisionId
        ? { divisionId: input.template.divisionId }
        : {}),
    });
    const resolved = await resolveTimezoneAndBuffer(
      trx,
      context.orgId,
      input.template.spaceId,
      input.template.programId,
    );
    if (input.template.spaceId && input.timezone !== resolved.timezone)
      throw new SchedulingRuleError(
        'Recurring event timezone must match the selected facility timezone.',
      );
    if (input.timezone !== resolved.timezone)
      throw new SchedulingRuleError(
        'Recurring event timezone must match the facility or organization timezone.',
      );
    const timezone = resolved.timezone;
    const horizonStart = localDateInTimezone(new Date(), timezone);
    const horizonEnd = localDateInTimezone(
      new Date(Date.now() + 548 * 86_400_000),
      timezone,
    );
    const occurrences = expand(
      {
        recurrence: input.recurrence,
        startTime: input.startTime,
        durationMinutes: input.durationMinutes,
        timezone,
      },
      horizonStart,
      horizonEnd,
    );
    if (occurrences.length > 400)
      throw new SchedulingRuleError(
        'A series may materialize at most 400 events.',
      );
    const seriesId = newId();
    await trx
      .insertInto('event_series')
      .values({
        id: seriesId,
        org_id: context.orgId,
        recurrence: input.recurrence as unknown as Json,
        start_time: input.startTime,
        duration_minutes: input.durationMinutes,
        timezone,
        template: input.template as unknown as Json,
      })
      .execute();
    const eventIds: string[] = [];
    for (const occurrence of occurrences) {
      const created = await createSeriesOccurrence(
        trx,
        context,
        seriesId,
        input.template,
        occurrence.startsAt,
        occurrence.endsAt,
        timezone,
        input.overrideReason,
      );
      eventIds.push(created);
    }
    await appendAuditEvent(trx, context, {
      action: 'schedule.series.create',
      entityType: 'event_series',
      entityId: seriesId,
      changes: input.overrideReason
        ? {
            conflictOverride: { tier: 'internal', after: input.overrideReason },
          }
        : {},
    });
    return { seriesId, eventIds };
  });
}

async function createSeriesOccurrence(
  trx: OrgTransaction,
  context: OrgContext,
  seriesId: string,
  template: Omit<
    EventCreateWithOverrideInput,
    'startsAt' | 'endsAt' | 'timezone'
  >,
  startsAtValue: string,
  endsAtValue: string,
  timezone: string,
  overrideReason?: string,
  excludedEventIds?: readonly string[],
): Promise<string> {
  const resolved = await resolveTimezoneAndBuffer(
    trx,
    context.orgId,
    template.spaceId,
    template.programId,
  );
  if (template.spaceId && timezone !== resolved.timezone)
    throw new SchedulingRuleError(
      'Recurring event timezone must match the selected facility timezone.',
    );
  const input = {
    ...template,
    startsAt: startsAtValue,
    endsAt: endsAtValue,
    timezone,
    overrideReason,
  } as EventCreateWithOverrideInput;
  const conflicts = await getConflicts(trx, context, input, excludedEventIds);
  const hard = conflicts.filter((conflict) => !conflict.overridable);
  const soft = conflicts.filter((conflict) => conflict.overridable);
  if (hard.length || (soft.length && !overrideReason))
    throw new SchedulingRuleError(
      'A recurring event conflicts with the schedule.',
      409,
      'SCHEDULE_CONFLICT',
      { conflicts },
    );
  const id = newId();
  await trx
    .insertInto('events')
    .values({
      id,
      org_id: context.orgId,
      program_id: input.programId ?? null,
      division_id: input.divisionId ?? null,
      kind: input.kind,
      title: input.title,
      starts_at: new Date(startsAtValue),
      ends_at: new Date(endsAtValue),
      timezone,
      space_id: input.spaceId ?? null,
      location_text: input.locationText ?? null,
      notes_html: safeNotes(input.notesHtml),
      arrival_minutes_before: input.arrivalMinutesBefore,
      series_id: seriesId,
      published: input.published,
    })
    .execute();
  await insertParticipants(trx, context.orgId, id, input.participants);
  if (input.spaceId) {
    await insertSpaceBooking(
      trx,
      context.orgId,
      input.spaceId,
      new Date(startsAtValue),
      new Date(endsAtValue),
      resolved.bufferMinutes,
      id,
    );
  }
  if (input.published) {
    const recipients = await eventRecipients(
      trx,
      context.orgId,
      input.participants,
    );
    await queueChangeBatch(
      trx,
      context,
      { id, title: input.title, startsAt: startsAtValue, endsAt: endsAtValue },
      recipients,
      'created',
    );
  }
  return id;
}

export async function editEventSeries(
  context: OrgContext,
  seriesId: string,
  input: import('./schema').SeriesEditInput,
): Promise<{ eventIds: string[]; seriesId: string | null }> {
  return withOrg(context, async (trx) => {
    const series = await trx
      .selectFrom('event_series')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', seriesId)
      .executeTakeFirst();
    if (!series)
      throw new SchedulingRuleError('Event series not found', 404, 'NOT_FOUND');
    if (series.version !== input.expectedVersion)
      throw new VersionConflictError(series);
    const occurrences = await trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('series_id', '=', seriesId)
      .orderBy('starts_at')
      .execute();
    const targetDate = input.occurrenceStartsAt;
    const selected = occurrences.find(
      (event) => event.starts_at.toISOString() === targetDate,
    );
    if (!selected)
      throw new SchedulingRuleError(
        'Series occurrence not found',
        404,
        'NOT_FOUND',
      );
    const scope = await scopeForEvent(trx, context.orgId, selected.id);
    if (!scope)
      throw new SchedulingRuleError(
        'Series occurrence not found',
        404,
        'NOT_FOUND',
      );
    await assertSchedulePermission(trx, context, 'schedule.manage', scope);

    if (input.scope === 'this') {
      const currentZone = selected.timezone;
      const startsAt = input.startsAt
        ? new Date(input.startsAt)
        : selected.starts_at;
      const endsAt = input.endsAt ? new Date(input.endsAt) : selected.ends_at;
      if (
        (input.startsAt && !input.endsAt) ||
        (!input.startsAt && input.endsAt)
      )
        throw new SchedulingRuleError(
          'Provide both event start and end times.',
        );
      const updated = await updateOccurrenceFromTemplate(
        trx,
        context,
        selected,
        input.template ?? {},
        startsAt,
        endsAt,
        input.overrideReason,
        currentZone,
      );
      const localDate = localDateInTimezone(selected.starts_at, currentZone);
      const oldRule =
        series.recurrence as unknown as import('@shared/recurrence').Recurrence;
      let nextRule: import('@shared/recurrence').Recurrence = oldRule;
      if (oldRule.kind === 'weekly' || oldRule.kind === 'monthly_nth_weekday') {
        nextRule = {
          ...oldRule,
          exceptions: [...new Set([...(oldRule.exceptions ?? []), localDate])],
        };
      }
      const updatedSeries = await trx
        .updateTable('event_series')
        .set({
          recurrence: nextRule as unknown as Json,
          active: oldRule.kind !== 'once',
          version: series.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', seriesId)
        .where('version', '=', input.expectedVersion)
        .returning('id')
        .executeTakeFirst();
      if (!updatedSeries) throw new VersionConflictError(series);
      await trx
        .updateTable('events')
        .set({ series_id: null })
        .where('org_id', '=', context.orgId)
        .where('id', '=', selected.id)
        .where('version', '=', updated.version)
        .execute();
      return { eventIds: [selected.id], seriesId: null };
    }

    if (!input.recurrence)
      throw new SchedulingRuleError(
        'A recurrence is required to update future series events.',
      );
    const now = new Date();
    const future = occurrences.filter(
      (event) =>
        event.status === 'scheduled' &&
        event.starts_at > now &&
        (input.scope === 'all' || event.starts_at >= selected.starts_at),
    );
    const timezone = input.recurrence.timezone;
    const resolved = await resolveTimezoneAndBuffer(
      trx,
      context.orgId,
      input.template?.spaceId === undefined
        ? (series.template as { spaceId?: string | null }).spaceId
        : input.template.spaceId,
      input.template?.programId === undefined
        ? (series.template as { programId?: string | null }).programId
        : input.template.programId,
    );
    const selectedSpaceId =
      input.template?.spaceId === undefined
        ? (series.template as { spaceId?: string | null }).spaceId
        : input.template.spaceId;
    const effectiveTimezone = selectedSpaceId
      ? resolved.timezone
      : series.timezone;
    if (timezone !== effectiveTimezone)
      throw new SchedulingRuleError(
        'Recurring event timezone must match the event timezone.',
      );
    const baseTemplate = series.template as Record<string, unknown>;
    const template = { ...baseTemplate, ...(input.template ?? {}) } as Omit<
      EventCreateWithOverrideInput,
      'startsAt' | 'endsAt' | 'timezone'
    >;
    const today = localDateInTimezone(now, effectiveTimezone);
    const horizonEnd = localDateInTimezone(
      new Date(now.getTime() + 548 * 86_400_000),
      effectiveTimezone,
    );
    const ignoredEventIds = future.map((event) => event.id);
    const occurrencesToCreate =
      input.scope === 'all'
        ? expand(
            { ...input.recurrence, timezone: effectiveTimezone },
            today,
            horizonEnd,
          )
        : expand(
            {
              ...input.recurrence,
              recurrence: recurrenceStartingAt(
                input.recurrence.recurrence,
                localDateInTimezone(selected.starts_at, effectiveTimezone),
              ),
              timezone: effectiveTimezone,
            },
            localDateInTimezone(selected.starts_at, effectiveTimezone),
            horizonEnd,
          );
    if (occurrencesToCreate.length > 400)
      throw new SchedulingRuleError(
        'A series may materialize at most 400 events.',
      );
    await trx
      .deleteFrom('space_bookings')
      .where('org_id', '=', context.orgId)
      .where('event_id', 'in', ignoredEventIds)
      .execute();
    for (const occurrence of occurrencesToCreate) {
      const candidate = {
        ...template,
        startsAt: occurrence.startsAt,
        endsAt: occurrence.endsAt,
        timezone: effectiveTimezone,
        overrideReason: input.overrideReason,
      } as EventCreateWithOverrideInput;
      const conflicts = await getConflicts(
        trx,
        context,
        candidate,
        ignoredEventIds,
      );
      const hard = conflicts.filter((conflict) => !conflict.overridable);
      const soft = conflicts.filter((conflict) => conflict.overridable);
      if (hard.length || (soft.length && !input.overrideReason))
        throw new SchedulingRuleError(
          'A recurring event conflicts with the schedule.',
          409,
          'SCHEDULE_CONFLICT',
          { conflicts },
        );
    }
    if (input.scope === 'all') {
      const updatedSeries = await trx
        .updateTable('event_series')
        .set({
          recurrence: input.recurrence.recurrence as unknown as Json,
          start_time: input.recurrence.startTime,
          duration_minutes: input.recurrence.durationMinutes,
          timezone: effectiveTimezone,
          template: template as Json,
          version: series.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', seriesId)
        .where('version', '=', input.expectedVersion)
        .returning('id')
        .executeTakeFirst();
      if (!updatedSeries) throw new VersionConflictError(series);
      const ids: string[] = [];
      const existingByDate = new Map(
        future.map((event) => [
          localDateInTimezone(event.starts_at, effectiveTimezone),
          event,
        ]),
      );
      for (const occurrence of occurrencesToCreate) {
        const existing = existingByDate.get(occurrence.localDate);
        if (existing) {
          const updated = await updateOccurrenceFromTemplate(
            trx,
            context,
            existing,
            template,
            new Date(occurrence.startsAt),
            new Date(occurrence.endsAt),
            input.overrideReason,
            effectiveTimezone,
            ignoredEventIds,
          );
          ids.push(updated.id);
          existingByDate.delete(occurrence.localDate);
        } else {
          ids.push(
            await createSeriesOccurrence(
              trx,
              context,
              seriesId,
              template,
              occurrence.startsAt,
              occurrence.endsAt,
              effectiveTimezone,
              input.overrideReason,
              ignoredEventIds,
            ),
          );
        }
      }
      for (const event of existingByDate.values()) {
        const canceled = await trx
          .updateTable('events')
          .set({
            status: 'canceled',
            status_reason: 'recurrence_series_updated',
            version: event.version + 1,
          })
          .where('org_id', '=', context.orgId)
          .where('id', '=', event.id)
          .where('version', '=', event.version)
          .returning('id')
          .executeTakeFirst();
        if (!canceled) throw new VersionConflictError(event);
        if (event.published) {
          const participants = await trx
            .selectFrom('event_participants')
            .selectAll()
            .where('org_id', '=', context.orgId)
            .where('event_id', '=', event.id)
            .execute();
          const recipients = await eventRecipients(
            trx,
            context.orgId,
            participants.flatMap((row) => [
              ...(row.person_id
                ? [
                    {
                      type: 'person' as const,
                      id: row.person_id,
                      side: row.side as 'home' | 'away' | 'none',
                    },
                  ]
                : []),
              ...(row.team_season_id
                ? [
                    {
                      type: 'team' as const,
                      id: row.team_season_id,
                      side: row.side as 'home' | 'away' | 'none',
                    },
                  ]
                : []),
            ]),
          );
          await queueChangeBatch(
            trx,
            context,
            {
              id: event.id,
              title: event.title,
              startsAt: event.starts_at.toISOString(),
              endsAt: event.ends_at.toISOString(),
            },
            recipients,
            'canceled',
          );
        }
      }
      if (input.overrideReason)
        await appendAuditEvent(trx, context, {
          action: 'schedule.series.conflict_override',
          entityType: 'event_series',
          entityId: seriesId,
          changes: {
            reason: { tier: 'internal', after: input.overrideReason },
          },
        });
      return { eventIds: ids, seriesId };
    }

    const selectedLocalDate = localDateInTimezone(
      selected.starts_at,
      effectiveTimezone,
    );
    const splitRecurrence = recurrenceStartingAt(
      input.recurrence.recurrence,
      selectedLocalDate,
    );
    const newTimedRecurrence = {
      ...input.recurrence,
      recurrence: splitRecurrence,
      timezone: effectiveTimezone,
    };
    const nextSeriesId = newId();
    await trx
      .insertInto('event_series')
      .values({
        id: nextSeriesId,
        org_id: context.orgId,
        recurrence: splitRecurrence as unknown as Json,
        start_time: input.recurrence.startTime,
        duration_minutes: input.recurrence.durationMinutes,
        timezone: effectiveTimezone,
        template: template as unknown as Json,
      })
      .execute();
    const ids: string[] = [];
    for (const event of future) {
      await trx
        .deleteFrom('space_bookings')
        .where('org_id', '=', context.orgId)
        .where('event_id', '=', event.id)
        .execute();
      const canceled = await trx
        .updateTable('events')
        .set({
          status: 'canceled',
          status_reason: 'recurrence_series_split',
          version: event.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', event.id)
        .where('version', '=', event.version)
        .returningAll()
        .executeTakeFirst();
      if (!canceled) throw new VersionConflictError(event);
      if (event.published) {
        const participants = await trx
          .selectFrom('event_participants')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('event_id', '=', event.id)
          .execute();
        const recipients = await eventRecipients(
          trx,
          context.orgId,
          participants.flatMap((row) => [
            ...(row.person_id
              ? [
                  {
                    type: 'person' as const,
                    id: row.person_id,
                    side: row.side as 'home' | 'away' | 'none',
                  },
                ]
              : []),
            ...(row.team_season_id
              ? [
                  {
                    type: 'team' as const,
                    id: row.team_season_id,
                    side: row.side as 'home' | 'away' | 'none',
                  },
                ]
              : []),
          ]),
        );
        await queueChangeBatch(
          trx,
          context,
          {
            id: event.id,
            title: event.title,
            startsAt: event.starts_at.toISOString(),
            endsAt: event.ends_at.toISOString(),
          },
          recipients,
          'canceled',
        );
      }
    }
    const newOccurrences = expand(
      newTimedRecurrence,
      selectedLocalDate,
      horizonEnd,
    );
    for (const occurrence of newOccurrences)
      ids.push(
        await createSeriesOccurrence(
          trx,
          context,
          nextSeriesId,
          template,
          occurrence.startsAt,
          occurrence.endsAt,
          effectiveTimezone,
          input.overrideReason,
          ignoredEventIds,
        ),
      );
    const truncatedRule = truncateRecurrenceBefore(
      series.recurrence as unknown as import('@shared/recurrence').Recurrence,
      selectedLocalDate,
    );
    const updatedSeries = await trx
      .updateTable('event_series')
      .set({
        recurrence: truncatedRule as unknown as Json,
        version: series.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', seriesId)
      .where('version', '=', input.expectedVersion)
      .returning('id')
      .executeTakeFirst();
    if (!updatedSeries) throw new VersionConflictError(series);
    if (input.overrideReason)
      await appendAuditEvent(trx, context, {
        action: 'schedule.series.conflict_override',
        entityType: 'event_series',
        entityId: nextSeriesId,
        changes: { reason: { tier: 'internal', after: input.overrideReason } },
      });
    return { eventIds: ids, seriesId: nextSeriesId };
  });
}

function recurrenceStartingAt(
  recurrence: import('@shared/recurrence').Recurrence,
  startsOn: string,
): import('@shared/recurrence').Recurrence {
  if (recurrence.kind === 'once') return { kind: 'once', date: startsOn };
  return { ...recurrence, startsOn };
}

function truncateRecurrenceBefore(
  recurrence: import('@shared/recurrence').Recurrence,
  splitDate: string,
): import('@shared/recurrence').Recurrence {
  if (recurrence.kind === 'once') return { kind: 'once', date: splitDate };
  const previousDate = new Date(`${splitDate}T00:00:00.000Z`);
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  const endsOn = previousDate.toISOString().slice(0, 10);
  if (endsOn < recurrence.startsOn) return { kind: 'once', date: splitDate };
  return { ...recurrence, endsOn };
}

async function updateOccurrenceFromTemplate(
  trx: OrgTransaction,
  context: OrgContext,
  current: {
    id: string;
    starts_at: Date;
    ends_at: Date;
    version: number;
    timezone: string;
    space_id: string | null;
    program_id: string | null;
    division_id: string | null;
    title: string;
    kind: string;
    location_text: string | null;
    notes_html: string | null;
    arrival_minutes_before: number;
    published: boolean;
  },
  template: Record<string, unknown>,
  startsAt: Date = current.starts_at,
  endsAt: Date = current.ends_at,
  overrideReason?: string,
  timezoneOverride?: string,
  excludedEventIds: readonly string[] = [current.id],
): Promise<{
  id: string;
  version: number;
  starts_at: Date;
  ends_at: Date;
  title: string;
  published: boolean;
}> {
  const parsed = template as Partial<EventCreateWithOverrideInput>;
  const spaceId =
    parsed.spaceId !== undefined ? parsed.spaceId : current.space_id;
  const programId =
    parsed.programId !== undefined ? parsed.programId : current.program_id;
  const divisionId =
    parsed.divisionId !== undefined ? parsed.divisionId : current.division_id;
  const resolved = await resolveTimezoneAndBuffer(
    trx,
    context.orgId,
    spaceId,
    programId,
  );
  const timezone = spaceId
    ? resolved.timezone
    : (timezoneOverride ?? current.timezone);
  let participants: EventCreateWithOverrideInput['participants'];
  if (parsed.participants) {
    participants = parsed.participants;
  } else {
    const rows = await trx
      .selectFrom('event_participants')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', current.id)
      .execute();
    participants = rows.flatMap((row) => [
      ...(row.team_season_id
        ? [
            {
              type: 'team' as const,
              id: row.team_season_id,
              side: row.side as 'home' | 'away' | 'none',
            },
          ]
        : []),
      ...(row.external_team_id
        ? [
            {
              type: 'external_team' as const,
              id: row.external_team_id,
              side: row.side as 'home' | 'away' | 'none',
            },
          ]
        : []),
      ...(row.person_id
        ? [
            {
              type: 'person' as const,
              id: row.person_id,
              side: row.side as 'home' | 'away' | 'none',
            },
          ]
        : []),
      ...(row.division_id
        ? [
            {
              type: 'division' as const,
              id: row.division_id,
              side: row.side as 'home' | 'away' | 'none',
            },
          ]
        : []),
    ]);
  }
  const candidate = {
    kind: parsed.kind ?? current.kind,
    title: parsed.title ?? current.title,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    timezone,
    programId,
    divisionId,
    spaceId,
    locationText:
      parsed.locationText !== undefined
        ? parsed.locationText
        : current.location_text,
    notesHtml:
      parsed.notesHtml !== undefined ? parsed.notesHtml : current.notes_html,
    arrivalMinutesBefore:
      parsed.arrivalMinutesBefore ?? current.arrival_minutes_before,
    participants,
    published: parsed.published ?? current.published,
    overrideReason,
  } as EventCreateWithOverrideInput;
  const conflicts = await getConflicts(
    trx,
    context,
    candidate,
    excludedEventIds,
  );
  const hard = conflicts.filter((conflict) => !conflict.overridable);
  const soft = conflicts.filter((conflict) => conflict.overridable);
  if (hard.length || (soft.length && !overrideReason))
    throw new SchedulingRuleError(
      'A recurring event conflicts with the schedule.',
      409,
      'SCHEDULE_CONFLICT',
      { conflicts },
    );
  await trx
    .deleteFrom('space_bookings')
    .where('org_id', '=', context.orgId)
    .where('event_id', '=', current.id)
    .execute();
  const updated = await trx
    .updateTable('events')
    .set({
      title: candidate.title,
      kind: candidate.kind,
      starts_at: startsAt,
      ends_at: endsAt,
      space_id: spaceId,
      program_id: programId,
      division_id: divisionId,
      location_text: candidate.locationText ?? null,
      notes_html: safeNotes(candidate.notesHtml),
      arrival_minutes_before: candidate.arrivalMinutesBefore,
      published: candidate.published,
      timezone,
      version: current.version + 1,
    })
    .where('org_id', '=', context.orgId)
    .where('id', '=', current.id)
    .where('version', '=', current.version)
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw new VersionConflictError(current);
  if (parsed.participants) {
    await trx
      .deleteFrom('event_participants')
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', current.id)
      .execute();
    await insertParticipants(
      trx,
      context.orgId,
      current.id,
      parsed.participants,
    );
  }
  if (spaceId)
    await insertSpaceBooking(
      trx,
      context.orgId,
      spaceId,
      startsAt,
      endsAt,
      resolved.bufferMinutes,
      current.id,
    );
  if (current.published || updated.published) {
    const recipients = await eventRecipients(trx, context.orgId, participants);
    await queueChangeBatch(
      trx,
      context,
      {
        id: current.id,
        title: updated.title,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      },
      recipients,
      'updated',
    );
  }
  if (soft.length)
    await appendAuditEvent(trx, context, {
      action: 'schedule.series.conflict_override',
      entityType: 'event',
      entityId: current.id,
      changes: { reason: { tier: 'internal', after: overrideReason ?? '' } },
    });
  return {
    id: updated.id,
    version: updated.version,
    starts_at: updated.starts_at,
    ends_at: updated.ends_at,
    title: updated.title,
    published: updated.published,
  };
}

export async function listFacilities(context: OrgContext) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.read');
    return trx
      .selectFrom('facilities')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('archived_at', 'is', null)
      .orderBy('name')
      .execute();
  });
}

export async function listSpaces(context: OrgContext, facilityId?: string) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.read');
    let query = trx
      .selectFrom('spaces')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('archived_at', 'is', null);
    if (facilityId) query = query.where('facility_id', '=', facilityId);
    return query.orderBy('facility_id').orderBy('name').execute();
  });
}

export async function createFacility(
  context: OrgContext,
  input: {
    name: string;
    address: Json | null;
    timezone: string | null;
    ownership: 'owned' | 'permitted' | 'partner';
    parkingNotes?: string | null;
    mapUrl?: string | null;
    isPublic?: boolean;
    layoutImageFileId?: string | null;
  },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    if (input.layoutImageFileId) {
      const asset = await trx
        .selectFrom('files')
        .select(['purpose', 'sensitivity', 'upload_state', 'deleted_at'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.layoutImageFileId)
        .executeTakeFirst();
      if (
        !asset ||
        asset.purpose !== 'website_asset' ||
        asset.sensitivity !== 'public' ||
        asset.upload_state !== 'complete' ||
        asset.deleted_at
      )
        throw new SchedulingRuleError(
          'Facility layouts must be completed public website assets in this organization.',
          400,
        );
    }
    const id = newId();
    await trx
      .insertInto('facilities')
      .values({
        id,
        org_id: context.orgId,
        name: input.name,
        address: input.address,
        timezone: input.timezone,
        ownership: input.ownership,
        parking_notes: input.parkingNotes ?? null,
        map_url: input.mapUrl ?? null,
        public: input.isPublic ?? false,
        layout_image_file_id: input.layoutImageFileId ?? null,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'schedule.facility.create',
      entityType: 'facility',
      entityId: id,
    });
    return trx
      .selectFrom('facilities')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  });
}

export async function createSpace(
  context: OrgContext,
  input: {
    facilityId: string;
    parentSpaceId?: string | null;
    name: string;
    kind: string;
    surface?: string | null;
    hasLights?: boolean;
    suitability?: Json;
    capacityPeople?: number | null;
  },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    if (input.parentSpaceId) {
      const existingBookings = await trx
        .selectFrom('space_bookings')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('leaf_space_id', '=', input.parentSpaceId)
        .where(sql<boolean>`upper(during) > now()`)
        .executeTakeFirst();
      if (existingBookings)
        throw new SchedulingRuleError(
          'This space has future bookings; move or cancel those events before creating child spaces.',
          409,
          'SCHEDULE_CONFLICT',
        );
    }
    const id = newId();
    await trx
      .insertInto('spaces')
      .values({
        id,
        org_id: context.orgId,
        facility_id: input.facilityId,
        parent_space_id: input.parentSpaceId ?? null,
        name: input.name,
        kind: input.kind,
        surface: input.surface ?? null,
        has_lights: input.hasLights ?? false,
        suitability: input.suitability ?? {},
        capacity_people: input.capacityPeople ?? null,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'schedule.space.create',
      entityType: 'space',
      entityId: id,
    });
    return trx
      .selectFrom('spaces')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  });
}

export async function createCalendarFeed(
  context: OrgContext,
  scope: { type: 'account' | 'team' | 'facility'; id?: string },
) {
  return withOrg(context, async (trx) => {
    if (
      scope.type === 'account' &&
      scope.id &&
      scope.id !== context.actor.accountId
    )
      throw new SchedulingRuleError(
        'Account feeds can only be created for yourself.',
        403,
        'FORBIDDEN',
      );
    await assertSchedulePermission(
      trx,
      context,
      scope.type === 'account' ? 'schedule.read' : 'schedule.manage',
      scope.type === 'team' && scope.id ? { teamSeasonId: scope.id } : {},
    );
    const token = randomBytes(32).toString('base64url');
    const id = newId();
    const scopeJson = {
      type: scope.type,
      ...(scope.id ? { id: scope.id } : {}),
    };
    await trx
      .insertInto('calendar_feeds')
      .values({
        id,
        account_id: scope.type === 'account' ? context.actor.accountId : null,
        team_season_id: scope.type === 'team' ? (scope.id ?? null) : null,
        org_id: context.orgId,
        token_hash: createHash('sha256').update(token).digest(),
        scope: scopeJson as unknown as Json,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'schedule.ics.create',
      entityType: 'calendar_feed',
      entityId: id,
    });
    return {
      id,
      url: `/api/v1/scheduling/orgs/${context.orgId}/feeds/${token}.ics`,
    };
  });
}

export async function getCalendarFeed(
  context: OrgContext,
  token: string,
): Promise<string> {
  const tokenHash = createHash('sha256').update(token).digest();
  return withOrg(context, async (trx) => {
    const feed = await trx
      .selectFrom('calendar_feeds')
      .select(['id', 'account_id', 'team_season_id', 'scope', 'revoked_at'])
      .where('org_id', '=', context.orgId)
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
    if (!feed || feed.revoked_at)
      throw new SchedulingRuleError(
        'Calendar feed not found.',
        404,
        'NOT_FOUND',
      );
    const scope = feed.scope as { type?: string; id?: string };
    let query = trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('published', '=', true)
      .orderBy('starts_at')
      .limit(1000);
    if (feed.team_season_id || (scope.type === 'team' && scope.id)) {
      const teamSeasonId = feed.team_season_id ?? scope.id;
      if (teamSeasonId) {
        const refs = await trx
          .selectFrom('event_participants')
          .select('event_id')
          .where('org_id', '=', context.orgId)
          .where('team_season_id', '=', teamSeasonId)
          .execute();
        const ids = refs.map((row) => row.event_id);
        if (!ids.length) return formatCalendarFeed([]);
        query = query.where('id', 'in', ids);
      }
    } else if (scope.type === 'facility' && scope.id) {
      const spaces = await trx
        .selectFrom('spaces')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('facility_id', '=', scope.id)
        .execute();
      query = query.where(
        'space_id',
        'in',
        spaces.map((row) => row.id),
      );
    } else if (feed.account_id) {
      const linked = await trx
        .selectFrom('person_account_links')
        .select('person_id')
        .where('org_id', '=', context.orgId)
        .where('account_id', '=', feed.account_id)
        .where('revoked_at', 'is', null)
        .execute();
      const personIds = linked.map((row) => row.person_id);
      const direct = personIds.length
        ? await trx
            .selectFrom('event_participants')
            .select('event_id')
            .where('org_id', '=', context.orgId)
            .where('person_id', 'in', personIds)
            .execute()
        : [];
      const teamLinks = personIds.length
        ? await trx
            .selectFrom('roster_entries')
            .select('team_season_id')
            .where('org_id', '=', context.orgId)
            .where('person_id', 'in', personIds)
            .where('status', 'in', ['active', 'injured', 'suspended'])
            .execute()
        : [];
      const teamIds = [...new Set(teamLinks.map((row) => row.team_season_id))];
      const teamEvents = teamIds.length
        ? await trx
            .selectFrom('event_participants')
            .select('event_id')
            .where('org_id', '=', context.orgId)
            .where('team_season_id', 'in', teamIds)
            .execute()
        : [];
      const ids = [
        ...new Set([...direct, ...teamEvents].map((row) => row.event_id)),
      ];
      query = ids.length
        ? query.where('id', 'in', ids)
        : query.where('id', '=', '00000000-0000-0000-0000-000000000000');
    }
    return formatCalendarFeed(await query.execute());
  });
}

function icsEscape(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll(/\r?\n/g, '\\n');
}

function foldIcsLine(line: string): string {
  const segments: string[] = [];
  let current = '';
  let octets = 0;
  for (const character of line) {
    const length = new TextEncoder().encode(character).length;
    if (octets + length > 75) {
      segments.push(current);
      current = ` ${character}`;
      octets = 1 + length;
    } else {
      current += character;
      octets += length;
    }
  }
  segments.push(current);
  return segments.join('\r\n');
}

export function formatCalendarFeed(
  rows: readonly {
    id: string;
    title: string;
    starts_at: Date;
    ends_at: Date;
    timezone: string;
    location_text: string | null;
    status?: string;
    version?: number;
  }[],
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Athlentry//Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const row of rows) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${row.id}@athlentry`);
    lines.push(`SEQUENCE:${String(row.version ?? 1)}`);
    lines.push(
      `DTSTAMP:${new Date()
        .toISOString()
        .replaceAll(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z')}`,
    );
    lines.push(
      `DTSTART:${row.starts_at
        .toISOString()
        .replaceAll(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z')}`,
    );
    lines.push(
      `DTEND:${row.ends_at
        .toISOString()
        .replaceAll(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z')}`,
    );
    lines.push(
      `STATUS:${row.status === 'canceled' ? 'CANCELLED' : 'CONFIRMED'}`,
    );
    lines.push(`SUMMARY:${icsEscape(row.title)}`);
    if (row.location_text)
      lines.push(`LOCATION:${icsEscape(row.location_text)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

export async function publicFacilityPage(orgSlug: string, facilityId: string) {
  const appDb = await import('../../db/kysely');
  const db = appDb.getDatabase();
  const organization = await db
    .selectFrom('organizations')
    .select(['id', 'slug', 'timezone'])
    .where('slug', '=', orgSlug)
    .executeTakeFirst();
  if (!organization)
    throw new SchedulingRuleError('Facility page not found.', 404, 'NOT_FOUND');
  return withOrg(
    { orgId: organization.id, actor: { accountId: newId() } },
    async (trx) => {
      const facility = await trx
        .selectFrom('facilities')
        .select([
          'id',
          'name',
          'address',
          'timezone',
          'parking_notes',
          'map_url',
          'layout_image_file_id',
        ])
        .where('org_id', '=', organization.id)
        .where('id', '=', facilityId)
        .where('public', '=', true)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (!facility)
        throw new SchedulingRuleError(
          'Facility page not found.',
          404,
          'NOT_FOUND',
        );
      const spaces = await trx
        .selectFrom('spaces')
        .selectAll()
        .where('org_id', '=', organization.id)
        .where('facility_id', '=', facilityId)
        .where('archived_at', 'is', null)
        .orderBy('name')
        .execute();
      const spaceIds = spaces.map((space) => space.id);
      const events = spaceIds.length
        ? await trx
            .selectFrom('events')
            .select([
              'id',
              'title',
              'kind',
              'starts_at',
              'ends_at',
              'timezone',
              'space_id',
              'status',
              'status_reason',
              'version',
            ])
            .where('org_id', '=', organization.id)
            .where('space_id', 'in', spaceIds)
            .where('published', '=', true)
            .where('starts_at', '>=', new Date(Date.now() - 24 * 60 * 60_000))
            .orderBy('starts_at')
            .limit(500)
            .execute()
        : [];
      const activeClosures = await trx
        .selectFrom('closures')
        .select([
          'scope_type',
          'scope_id',
          'starts_at',
          'ends_at',
          'reason',
          'message',
        ])
        .where('org_id', '=', organization.id)
        .where('starts_at', '<=', new Date(Date.now() + 30 * 86_400_000))
        .where('ends_at', '>', new Date())
        .where((eb) =>
          eb.or([
            eb('scope_type', '=', 'org'),
            eb.and([
              eb('scope_type', '=', 'facility'),
              eb('scope_id', '=', facilityId),
            ]),
            ...(spaceIds.length
              ? [
                  eb.and([
                    eb('scope_type', '=', 'space'),
                    eb('scope_id', 'in', spaceIds),
                  ]),
                ]
              : []),
          ]),
        )
        .execute();
      return {
        facility,
        spaces,
        events,
        closures: activeClosures,
        organizationTimezone: organization.timezone,
      };
    },
  );
}

export function generatorInputFromConstraints(
  constraints: GeneratorConstraints,
  values: {
    divisions: unknown[];
    teams: unknown[];
    spaces: unknown[];
    timezone: string;
    durationMinutes: number;
    bufferMinutes: number;
  },
) {
  return {
    ...values,
    ...constraints,
    divisions: (constraints.divisions ?? []).map((division) => ({
      id: division.divisionId,
      allowedWeekdays: division.allowedWeekdays,
      timeWindows: division.timeWindows,
      ...(division.gamesPerTeam === undefined
        ? {}
        : { gamesPerTeam: division.gamesPerTeam }),
      ...(division.roundRobin === undefined
        ? {}
        : { roundRobin: division.roundRobin }),
      ...(division.preferredStartMinutes === undefined
        ? {}
        : { preferredStartMinutes: division.preferredStartMinutes }),
      ...(division.ageOrder === undefined
        ? {}
        : { ageOrder: division.ageOrder }),
      teamIds: [],
    })),
    divisionsFromDatabase: values.divisions,
  };
}
