import { newId } from '@shared/ids';
import { expand } from '@shared/recurrence';
import { sql } from 'kysely';

import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { VersionConflictError } from '../../lib/version-check';
import { appendAuditEvent } from '../audit/service';

import { assertSchedulePermission } from './access';
import {
  eventRecipients,
  getConflicts,
  insertSpaceBooking,
  queueChangeBatch,
  resolveTimezoneAndBuffer,
  scopeForEvent,
  SchedulingRuleError,
} from './events';
import type { EventCreateWithOverrideInput } from './schema';

export type ClosureInput = {
  scopeType: 'facility' | 'space' | 'org';
  scopeId?: string | null;
  startsAt: string;
  endsAt: string;
  reason: 'weather' | 'maintenance' | 'permit' | 'other';
  message?: string | null;
  previewOnly: boolean;
};

async function closureEvents(
  trx: OrgTransaction,
  orgId: string,
  input: ClosureInput,
) {
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (startsAt >= endsAt)
    throw new SchedulingRuleError('Closure end must follow its start.');
  if (input.scopeType !== 'org' && !input.scopeId)
    throw new SchedulingRuleError(
      'Facility and space closures require a scope id.',
    );
  let query = trx
    .selectFrom('events')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('starts_at', '<', endsAt)
    .where('ends_at', '>', startsAt)
    .where('status', '=', 'scheduled')
    .orderBy('starts_at')
    .limit(1000);
  if (input.scopeType === 'space')
    query = query.where('space_id', '=', input.scopeId ?? '');
  if (input.scopeType === 'facility') {
    const spaces = await trx
      .selectFrom('spaces')
      .select('id')
      .where('org_id', '=', orgId)
      .where('facility_id', '=', input.scopeId ?? '')
      .execute();
    query = query.where(
      'space_id',
      'in',
      spaces.map((space) => space.id),
    );
  }
  return query.execute();
}

export async function previewClosure(context: OrgContext, input: ClosureInput) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const rows = await closureEvents(trx, context.orgId, input);
    return {
      count: rows.length,
      events: rows.map((row) => ({
        id: row.id,
        title: row.title,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        published: row.published,
      })),
    };
  });
}

export async function createClosure(context: OrgContext, input: ClosureInput) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const affected = await closureEvents(trx, context.orgId, input);
    if (input.previewOnly) {
      return {
        preview: true,
        affected: affected.map((row) => ({
          id: row.id,
          title: row.title,
          startsAt: row.starts_at.toISOString(),
        })),
      };
    }
    const id = newId();
    await trx
      .insertInto('closures')
      .values({
        id,
        org_id: context.orgId,
        scope_type: input.scopeType,
        scope_id: input.scopeType === 'org' ? null : (input.scopeId ?? null),
        starts_at: new Date(input.startsAt),
        ends_at: new Date(input.endsAt),
        reason: input.reason,
        message: input.message ?? null,
        created_by: context.actor.accountId,
        affected_event_ids: affected.map((event) => event.id),
      })
      .execute();
    for (const event of affected) {
      await trx
        .deleteFrom('space_bookings')
        .where('org_id', '=', context.orgId)
        .where('event_id', '=', event.id)
        .execute();
      const updated = await trx
        .updateTable('events')
        .set({
          status: 'postponed',
          status_reason: `closure:${id}`,
          version: event.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', event.id)
        .where('version', '=', event.version)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new VersionConflictError(event);
      if (event.published) {
        const participants = await trx
          .selectFrom('event_participants')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('event_id', '=', event.id)
          .execute();
        const people = participants.flatMap((row) => [
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
        ]);
        const recipients = await eventRecipients(
          trx,
          context.orgId,
          people,
          event.id,
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
          'postponed',
          'safety.emergency',
        );
      }
    }
    await appendAuditEvent(trx, context, {
      action: 'schedule.closure.create',
      entityType: 'closure',
      entityId: id,
      changes: { affectedCount: { tier: 'internal', after: affected.length } },
    });
    return {
      id,
      affectedEventIds: affected.map((event) => event.id),
      preview: false,
    };
  });
}

export async function createAllocation(
  context: OrgContext,
  input: {
    spaceId: string;
    teamSeasonId?: string | null;
    divisionId?: string | null;
    recurrence: import('@shared/recurrence').Recurrence;
    startsOn: string;
    endsOn: string;
    startTime: string;
    endTime: string;
    timezone: string;
    purpose: 'practice' | 'games' | 'clinic' | 'other';
  },
) {
  return withOrg(context, async (trx) => {
    const scope = {
      ...(input.teamSeasonId ? { teamSeasonId: input.teamSeasonId } : {}),
      ...(input.divisionId ? { divisionId: input.divisionId } : {}),
    };
    await assertSchedulePermission(trx, context, 'schedule.manage', scope);
    if ((input.teamSeasonId == null) === (input.divisionId == null))
      throw new SchedulingRuleError(
        'Choose a team or division for the allocation.',
      );
    const start = new Date(`2000-01-01T${input.startTime}Z`).getTime();
    const end = new Date(`2000-01-01T${input.endTime}Z`).getTime();
    if (end <= start)
      throw new SchedulingRuleError(
        'Allocation end time must follow the start time.',
      );
    const durationMinutes = (end - start) / 60_000;
    const occurrences = expand(
      {
        recurrence: input.recurrence,
        startTime: input.startTime,
        durationMinutes,
        timezone: input.timezone,
      },
      input.startsOn,
      input.endsOn,
    );
    if (occurrences.length > 520)
      throw new SchedulingRuleError(
        'An allocation may create at most 520 recurring bookings.',
      );
    const id = newId();
    await trx
      .insertInto('allocations')
      .values({
        id,
        org_id: context.orgId,
        space_id: input.spaceId,
        team_season_id: input.teamSeasonId ?? null,
        division_id: input.divisionId ?? null,
        recurrence: input.recurrence as never,
        starts_on: input.startsOn,
        ends_on: input.endsOn,
        start_time: input.startTime,
        end_time: input.endTime,
        purpose: input.purpose,
      })
      .execute();
    const leaves = await sql<{ id: string }>`
      WITH RECURSIVE descendants AS (
        SELECT id FROM spaces WHERE org_id = ${context.orgId} AND id = ${input.spaceId}
        UNION ALL
        SELECT child.id FROM spaces child JOIN descendants parent ON child.parent_space_id = parent.id
        WHERE child.org_id = ${context.orgId}
      )
      SELECT d.id FROM descendants d WHERE NOT EXISTS (
        SELECT 1 FROM spaces child WHERE child.org_id = ${context.orgId} AND child.parent_space_id = d.id
      )
    `.execute(trx);
    if (!leaves.rows.length)
      throw new SchedulingRuleError('Space not found.', 404, 'NOT_FOUND');
    for (const occurrence of occurrences) {
      const bookingGroupId = newId();
      const startsAt = new Date(occurrence.startsAt);
      const endsAt = new Date(occurrence.endsAt);
      for (const leaf of leaves.rows) {
        await trx
          .insertInto('space_bookings')
          .values({
            id: newId(),
            org_id: context.orgId,
            booking_group_id: bookingGroupId,
            leaf_space_id: leaf.id,
            during: sql`tstzrange(${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz, '[)')`,
            event_id: null,
            allocation_id: id,
          })
          .execute();
      }
    }
    await appendAuditEvent(trx, context, {
      action: 'schedule.allocation.create',
      entityType: 'allocation',
      entityId: id,
    });
    return trx
      .selectFrom('allocations')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  });
}

export async function requestAllocationSlot(
  context: OrgContext,
  allocationId: string,
  input: { startsAt: string; endsAt: string },
) {
  return withOrg(context, async (trx) => {
    const allocation = await trx
      .selectFrom('allocations')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', allocationId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!allocation)
      throw new SchedulingRuleError('Allocation not found.', 404, 'NOT_FOUND');
    if (!allocation.team_season_id)
      throw new SchedulingRuleError(
        'Self-service requests require a team allocation.',
        403,
        'FORBIDDEN',
      );
    await assertSchedulePermission(trx, context, 'attendance.manage', {
      teamSeasonId: allocation.team_season_id,
    });
    const setting = await trx
      .selectFrom('schedule_settings')
      .select('coach_slot_picker_enabled')
      .where('org_id', '=', context.orgId)
      .where(
        'program_id',
        '=',
        (
          await trx
            .selectFrom('team_seasons')
            .select('program_id')
            .where('org_id', '=', context.orgId)
            .where('id', '=', allocation.team_season_id)
            .executeTakeFirstOrThrow()
        ).program_id,
      )
      .executeTakeFirst();
    if (!setting?.coach_slot_picker_enabled)
      throw new SchedulingRuleError(
        'Practice slot self-service is not enabled for this program.',
        403,
        'FORBIDDEN',
      );
    const start = new Date(input.startsAt);
    const end = new Date(input.endsAt);
    const facility = await trx
      .selectFrom('spaces')
      .innerJoin('facilities', 'facilities.id', 'spaces.facility_id')
      .select('facilities.timezone')
      .where('spaces.org_id', '=', context.orgId)
      .where('spaces.id', '=', allocation.space_id)
      .executeTakeFirstOrThrow();
    const duration =
      (new Date(`2000-01-01T${allocation.end_time}Z`).getTime() -
        new Date(`2000-01-01T${allocation.start_time}Z`).getTime()) /
      60_000;
    const localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: facility.timezone ?? 'UTC',
    }).format(start);
    const valid = expand(
      {
        recurrence: allocation.recurrence as never,
        startTime: allocation.start_time,
        durationMinutes: duration,
        timezone: facility.timezone ?? 'UTC',
      },
      localDate,
      localDate,
    ).some(
      (slot) =>
        new Date(slot.startsAt).getTime() === start.getTime() &&
        new Date(slot.endsAt).getTime() === end.getTime(),
    );
    if (!valid)
      throw new SchedulingRuleError(
        'Choose a slot from the allocated practice block.',
      );
    const settings = await trx
      .selectFrom('schedule_settings')
      .select('slot_approval_required')
      .where('org_id', '=', context.orgId)
      .where(
        'program_id',
        '=',
        (
          await trx
            .selectFrom('team_seasons')
            .select('program_id')
            .where('org_id', '=', context.orgId)
            .where('id', '=', allocation.team_season_id)
            .executeTakeFirstOrThrow()
        ).program_id,
      )
      .executeTakeFirst();
    const id = newId();
    const request = await trx
      .insertInto('allocation_requests')
      .values({
        id,
        org_id: context.orgId,
        allocation_id: allocationId,
        requested_by: context.actor.accountId,
        starts_at: start,
        ends_at: end,
        status:
          settings?.slot_approval_required === false ? 'approved' : 'pending',
        ...(settings?.slot_approval_required === false
          ? { decided_by: context.actor.accountId }
          : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (request.status === 'approved') {
      const eventId = await makePracticeEvent(
        trx,
        context,
        allocation,
        start,
        end,
      );
      await trx
        .updateTable('allocation_requests')
        .set({ resulting_event_id: eventId })
        .where('org_id', '=', context.orgId)
        .where('id', '=', id)
        .execute();
    }
    await appendAuditEvent(trx, context, {
      action: 'schedule.allocation.request',
      entityType: 'allocation_request',
      entityId: id,
    });
    return { id, status: request.status };
  });
}

async function makePracticeEvent(
  trx: OrgTransaction,
  context: OrgContext,
  allocation: {
    space_id: string;
    team_season_id: string | null;
    division_id: string | null;
  },
  startsAt: Date,
  endsAt: Date,
): Promise<string> {
  const eventId = newId();
  const team = allocation.team_season_id
    ? await trx
        .selectFrom('team_seasons')
        .select(['program_id', 'division_id'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', allocation.team_season_id)
        .executeTakeFirst()
    : null;
  const space = await trx
    .selectFrom('spaces')
    .innerJoin('facilities', (join) =>
      join
        .onRef('facilities.org_id', '=', 'spaces.org_id')
        .onRef('facilities.id', '=', 'spaces.facility_id'),
    )
    .select('facilities.timezone')
    .where('spaces.org_id', '=', context.orgId)
    .where('spaces.id', '=', allocation.space_id)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('events')
    .values({
      id: eventId,
      org_id: context.orgId,
      program_id: team?.program_id ?? null,
      division_id: team?.division_id ?? allocation.division_id,
      kind: 'practice',
      title: 'Team practice',
      starts_at: startsAt,
      ends_at: endsAt,
      timezone: space.timezone ?? 'UTC',
      space_id: allocation.space_id,
      published: false,
    })
    .execute();
  if (allocation.team_season_id)
    await trx
      .insertInto('event_participants')
      .values({
        id: newId(),
        org_id: context.orgId,
        event_id: eventId,
        team_season_id: allocation.team_season_id,
        side: 'none',
      })
      .execute();
  const leaves = await sql<{ id: string }>`
    WITH RECURSIVE descendants AS (
      SELECT id FROM spaces WHERE org_id = ${context.orgId} AND id = ${allocation.space_id}
      UNION ALL SELECT child.id FROM spaces child JOIN descendants parent ON child.parent_space_id = parent.id WHERE child.org_id = ${context.orgId}
    ) SELECT d.id FROM descendants d WHERE NOT EXISTS (
      SELECT 1 FROM spaces child WHERE child.org_id = ${context.orgId} AND child.parent_space_id = d.id
    )
  `.execute(trx);
  const group = newId();
  for (const leaf of leaves.rows) {
    await trx
      .insertInto('space_bookings')
      .values({
        id: newId(),
        org_id: context.orgId,
        booking_group_id: group,
        leaf_space_id: leaf.id,
        during: sql`tstzrange(${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz, '[)')`,
        event_id: eventId,
        allocation_id: null,
      })
      .execute();
  }
  return eventId;
}

export async function decideAllocationRequest(
  context: OrgContext,
  requestId: string,
  input: { approve: boolean; expectedVersion: number },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const request = await trx
      .selectFrom('allocation_requests')
      .innerJoin('allocations', (join) =>
        join
          .onRef('allocations.org_id', '=', 'allocation_requests.org_id')
          .onRef('allocations.id', '=', 'allocation_requests.allocation_id'),
      )
      .selectAll('allocation_requests')
      .select([
        'allocations.space_id',
        'allocations.team_season_id',
        'allocations.division_id',
      ])
      .where('allocation_requests.org_id', '=', context.orgId)
      .where('allocation_requests.id', '=', requestId)
      .executeTakeFirst();
    if (!request)
      throw new SchedulingRuleError(
        'Allocation request not found.',
        404,
        'NOT_FOUND',
      );
    if (request.version !== input.expectedVersion)
      throw new VersionConflictError(request);
    if (request.status !== 'pending')
      throw new SchedulingRuleError(
        'Allocation request has already been decided.',
        409,
        'CONFLICT',
      );
    const eventId = input.approve
      ? await makePracticeEvent(
          trx,
          context,
          request,
          request.starts_at,
          request.ends_at,
        )
      : null;
    const updated = await trx
      .updateTable('allocation_requests')
      .set({
        status: input.approve ? 'approved' : 'declined',
        decided_by: context.actor.accountId,
        resulting_event_id: eventId,
        version: request.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', requestId)
      .where('version', '=', input.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(request);
    await appendAuditEvent(trx, context, {
      action: `schedule.allocation.${input.approve ? 'approve' : 'decline'}`,
      entityType: 'allocation_request',
      entityId: requestId,
    });
    return { id: requestId, status: updated.status, eventId };
  });
}

export async function listAllocationRequests(context: OrgContext) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    return trx
      .selectFrom('allocation_requests')
      .innerJoin('allocations', (join) =>
        join
          .onRef('allocations.org_id', '=', 'allocation_requests.org_id')
          .onRef('allocations.id', '=', 'allocation_requests.allocation_id'),
      )
      .selectAll('allocation_requests')
      .select([
        'allocations.space_id',
        'allocations.team_season_id',
        'allocations.division_id',
      ])
      .where('allocation_requests.org_id', '=', context.orgId)
      .where('allocation_requests.status', '=', 'pending')
      .orderBy('allocation_requests.created_at')
      .execute();
  });
}

export async function requestReschedule(
  context: OrgContext,
  eventId: string,
  input: {
    reason: string;
    proposedSlots: readonly {
      startsAt: string;
      endsAt: string;
      spaceId?: string | null;
    }[];
  },
) {
  return withOrg(context, async (trx) => {
    const scope = await scopeForEvent(trx, context.orgId, eventId);
    if (!scope)
      throw new SchedulingRuleError('Event not found.', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'schedule.read', scope);
    const event = await trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    const participants = await trx
      .selectFrom('event_participants')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .execute();
    const teamParticipants = participants.flatMap((participant) =>
      participant.team_season_id
        ? [
            {
              type: 'team' as const,
              id: participant.team_season_id,
              side: participant.side as 'home' | 'away' | 'none',
            },
          ]
        : [],
    );
    const slots = [];
    for (const proposed of input.proposedSlots) {
      const candidate = {
        kind: event.kind as EventCreateWithOverrideInput['kind'],
        title: event.title,
        startsAt: proposed.startsAt,
        endsAt: proposed.endsAt,
        timezone: event.timezone,
        programId: event.program_id,
        divisionId: event.division_id,
        spaceId: proposed.spaceId ?? event.space_id,
        locationText: event.location_text,
        notesHtml: event.notes_html,
        arrivalMinutesBefore: event.arrival_minutes_before,
        participants: teamParticipants,
        published: event.published,
      } as EventCreateWithOverrideInput;
      const conflicts = await getConflicts(trx, context, candidate, eventId);
      if (conflicts.some((item) => !item.overridable)) continue;
      slots.push(proposed);
    }
    if (!slots.length)
      throw new SchedulingRuleError(
        'No proposed slot is available.',
        409,
        'SCHEDULE_CONFLICT',
      );
    const id = newId();
    await trx
      .insertInto('reschedule_requests')
      .values({
        id,
        org_id: context.orgId,
        event_id: eventId,
        requested_by: context.actor.accountId,
        reason: input.reason,
        proposed_slots: slots as never,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'schedule.reschedule.request',
      entityType: 'reschedule_request',
      entityId: id,
    });
    return { id, status: 'open', proposedSlots: slots };
  });
}

export async function decideRescheduleRequest(
  context: OrgContext,
  requestId: string,
  input: { approve: boolean; slotIndex?: number; expectedVersion: number },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    const request = await trx
      .selectFrom('reschedule_requests')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', requestId)
      .executeTakeFirst();
    if (!request)
      throw new SchedulingRuleError(
        'Reschedule request not found.',
        404,
        'NOT_FOUND',
      );
    if (request.version !== input.expectedVersion)
      throw new VersionConflictError(request);
    if (request.status !== 'open')
      throw new SchedulingRuleError(
        'Request has already been decided.',
        409,
        'CONFLICT',
      );
    let resultingEventId: string | null = null;
    if (input.approve) {
      const proposals = request.proposed_slots as Array<{
        startsAt: string;
        endsAt: string;
        spaceId?: string | null;
      }>;
      const slot = proposals[input.slotIndex ?? 0];
      if (!slot) throw new SchedulingRuleError('Choose a proposed slot.');
      const event = await trx
        .selectFrom('events')
        .selectAll()
        .where('org_id', '=', context.orgId)
        .where('id', '=', request.event_id)
        .executeTakeFirstOrThrow();
      const participants = await trx
        .selectFrom('event_participants')
        .selectAll()
        .where('org_id', '=', context.orgId)
        .where('event_id', '=', event.id)
        .execute();
      const teams = participants.flatMap((participant) =>
        participant.team_season_id
          ? [
              {
                type: 'team' as const,
                id: participant.team_season_id,
                side: participant.side as 'home' | 'away' | 'none',
              },
            ]
          : [],
      );
      const scope = await scopeForEvent(trx, context.orgId, event.id);
      if (!scope)
        throw new SchedulingRuleError('Event not found.', 404, 'NOT_FOUND');
      const candidate = {
        kind: event.kind as EventCreateWithOverrideInput['kind'],
        title: event.title,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        timezone: event.timezone,
        programId: event.program_id,
        divisionId: event.division_id,
        spaceId: slot.spaceId ?? event.space_id,
        locationText: event.location_text,
        notesHtml: event.notes_html,
        arrivalMinutesBefore: event.arrival_minutes_before,
        participants: teams,
        published: event.published,
      } as EventCreateWithOverrideInput;
      const conflicts = await getConflicts(trx, context, candidate, event.id);
      if (conflicts.some((item) => !item.overridable))
        throw new SchedulingRuleError(
          'The selected slot is no longer free.',
          409,
          'SCHEDULE_CONFLICT',
          { conflicts },
        );
      await trx
        .deleteFrom('space_bookings')
        .where('org_id', '=', context.orgId)
        .where('event_id', '=', event.id)
        .execute();
      const updated = await trx
        .updateTable('events')
        .set({
          starts_at: new Date(slot.startsAt),
          ends_at: new Date(slot.endsAt),
          space_id: slot.spaceId ?? event.space_id,
          version: event.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', event.id)
        .where('version', '=', event.version)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new VersionConflictError(event);
      if (updated.space_id) {
        const { bufferMinutes } = await resolveTimezoneAndBuffer(
          trx,
          context.orgId,
          updated.space_id,
          updated.program_id,
        );
        await insertSpaceBooking(
          trx,
          context.orgId,
          updated.space_id,
          updated.starts_at,
          updated.ends_at,
          bufferMinutes,
          updated.id,
        );
      }
      const recipients = await eventRecipients(trx, context.orgId, teams);
      await queueChangeBatch(
        trx,
        context,
        {
          id: updated.id,
          title: updated.title,
          startsAt: updated.starts_at.toISOString(),
          endsAt: updated.ends_at.toISOString(),
        },
        recipients,
        'updated',
      );
      resultingEventId = event.id;
    }
    const updatedRequest = await trx
      .updateTable('reschedule_requests')
      .set({
        status: input.approve ? 'approved' : 'declined',
        decided_by: context.actor.accountId,
        resulting_event_id: resultingEventId,
        version: request.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', requestId)
      .where('version', '=', input.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updatedRequest) throw new VersionConflictError(request);
    await appendAuditEvent(trx, context, {
      action: `schedule.reschedule.${input.approve ? 'approve' : 'decline'}`,
      entityType: 'reschedule_request',
      entityId: requestId,
    });
    return { id: requestId, status: updatedRequest.status, resultingEventId };
  });
}

export async function listRescheduleRequests(context: OrgContext) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage');
    return trx
      .selectFrom('reschedule_requests')
      .innerJoin('events', (join) =>
        join
          .onRef('events.org_id', '=', 'reschedule_requests.org_id')
          .onRef('events.id', '=', 'reschedule_requests.event_id'),
      )
      .selectAll('reschedule_requests')
      .select(['events.title', 'events.starts_at', 'events.timezone'])
      .where('reschedule_requests.org_id', '=', context.orgId)
      .where('reschedule_requests.status', '=', 'open')
      .orderBy('reschedule_requests.created_at')
      .execute();
  });
}
