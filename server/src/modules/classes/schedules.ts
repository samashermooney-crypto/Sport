import { newId } from '@shared/ids';
import type { ComplianceMissing } from '@shared/policies/compliance-gate';
import { expand } from '@shared/recurrence';
import type { Recurrence } from '@shared/recurrence';
import type {
  ClassSchedule,
  ClassScheduleBody,
  ClassScheduleUpdate,
  InstructorAssign,
} from '@shared/schemas/classes';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { requireVersion } from '../../lib/version-check.js';
import { appendAuditEvent } from '../audit/service.js';
import {
  evaluateRoleEligibility,
  RoleEligibilityError,
} from '../compliance/policy.js';

import { ClassesConflictError, ClassesNotFoundError } from './errors.js';

const MAX_SESSIONS_PER_SCHEDULE = 370;

export interface ScheduleRow {
  id: string;
  org_id: string;
  class_offering_id: string;
  recurrence: unknown;
  start_time: string;
  duration_minutes: number;
  timezone: string;
  space_id: string | null;
  location_text: string | null;
  term_start: string;
  term_end: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface InstructorRow {
  id: string;
  person_id: string;
  status: string;
  first_name: string;
  last_name: string;
}

function stripExceptions(recurrence: Recurrence): Recurrence {
  if (recurrence.kind === 'once') return recurrence;
  const clone = { ...recurrence } as Record<string, unknown>;
  clone['exceptions'] = [];
  if ('additions' in clone) clone['additions'] = [];
  return clone as Recurrence;
}

/** Materialize class_session events for a schedule inside a transaction. */
async function materializeScheduleSessions(
  trx: OrgTransaction,
  context: OrgContext,
  schedule: {
    id: string;
    classOfferingId: string;
    recurrence: Recurrence;
    startTime: string;
    durationMinutes: number;
    timezone: string;
    spaceId: string | null;
    locationText: string | null;
    termStart: string;
    termEnd: string;
    title: string;
    programId: string;
    capacity: number;
  },
  rangeStart: string,
  rangeEnd: string,
): Promise<{ created: number; skippedHolidays: number }> {
  const end = rangeEnd < schedule.termEnd ? rangeEnd : schedule.termEnd;
  const start =
    rangeStart > schedule.termStart ? rangeStart : schedule.termStart;
  if (start > end) return { created: 0, skippedHolidays: 0 };

  const timed = {
    recurrence: schedule.recurrence,
    startTime: schedule.startTime,
    durationMinutes: schedule.durationMinutes,
    timezone: schedule.timezone,
  };
  const occurrences = expand(timed, start, end).slice(
    0,
    MAX_SESSIONS_PER_SCHEDULE,
  );
  const allDates = expand(
    { ...timed, recurrence: stripExceptions(schedule.recurrence) },
    start,
    end,
  ).slice(0, MAX_SESSIONS_PER_SCHEDULE + 60);
  const liveDates = new Set(occurrences.map((item) => item.localDate));
  const skipped = allDates.filter((item) => !liveDates.has(item.localDate));

  const existing = await trx
    .selectFrom('class_sessions')
    .innerJoin('events', (join) =>
      join
        .onRef('events.org_id', '=', 'class_sessions.org_id')
        .onRef('events.id', '=', 'class_sessions.event_id'),
    )
    .select(['class_sessions.id', sql<Date>`events.starts_at`.as('starts')])
    .where('class_sessions.org_id', '=', context.orgId)
    .where('class_sessions.class_schedule_id', '=', schedule.id)
    .execute();
  const existingDates = new Set(
    existing.map((row) => row.starts.toISOString().slice(0, 10)),
  );

  const seriesId = newId();
  await trx
    .insertInto('event_series')
    .values({
      id: seriesId,
      org_id: context.orgId,
      recurrence: JSON.stringify(schedule.recurrence),
      start_time: schedule.startTime,
      duration_minutes: schedule.durationMinutes,
      timezone: schedule.timezone,
      template: JSON.stringify({
        kind: 'class_session',
        title: schedule.title,
        spaceId: schedule.spaceId,
        locationText: schedule.locationText,
        programId: schedule.programId,
        classOfferingId: schedule.classOfferingId,
        classScheduleId: schedule.id,
      }),
    })
    .execute();

  let created = 0;
  for (const occurrence of occurrences) {
    if (existingDates.has(occurrence.localDate)) continue;
    const eventId = newId();
    await trx
      .insertInto('events')
      .values({
        id: eventId,
        org_id: context.orgId,
        kind: 'class_session',
        title: schedule.title,
        starts_at: occurrence.startsAt,
        ends_at: occurrence.endsAt,
        timezone: schedule.timezone,
        program_id: schedule.programId,
        series_id: seriesId,
        space_id: schedule.spaceId,
        location_text: schedule.locationText,
        published: true,
        status: 'scheduled',
      })
      .execute();
    await trx
      .insertInto('class_sessions')
      .values({
        id: newId(),
        org_id: context.orgId,
        event_id: eventId,
        class_offering_id: schedule.classOfferingId,
        class_schedule_id: schedule.id,
        capacity: schedule.capacity,
        holiday_skipped: false,
      })
      .execute();
    created += 1;
  }
  for (const occurrence of skipped) {
    if (existingDates.has(occurrence.localDate)) continue;
    const eventId = newId();
    await trx
      .insertInto('events')
      .values({
        id: eventId,
        org_id: context.orgId,
        kind: 'class_session',
        title: `${schedule.title} (no class)`,
        starts_at: occurrence.startsAt,
        ends_at: occurrence.endsAt,
        timezone: schedule.timezone,
        program_id: schedule.programId,
        series_id: seriesId,
        space_id: schedule.spaceId,
        location_text: schedule.locationText,
        published: true,
        status: 'canceled',
        status_reason: 'Holiday or blackout date',
      })
      .execute();
    await trx
      .insertInto('class_sessions')
      .values({
        id: newId(),
        org_id: context.orgId,
        event_id: eventId,
        class_offering_id: schedule.classOfferingId,
        class_schedule_id: schedule.id,
        capacity: schedule.capacity,
        holiday_skipped: true,
      })
      .execute();
  }
  return { created, skippedHolidays: skipped.length };
}

function mapSchedule(
  row: ScheduleRow,
  instructors: InstructorRow[],
  spaceName: string | null,
  sessionCount: number,
): ClassSchedule {
  return {
    id: row.id,
    orgId: row.org_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    classOfferingId: row.class_offering_id,
    recurrence: row.recurrence as ClassSchedule['recurrence'],
    startTime: row.start_time.slice(0, 5),
    durationMinutes: row.duration_minutes,
    timezone: row.timezone,
    spaceId: row.space_id,
    locationText: row.location_text,
    spaceName,
    termStart:
      typeof row.term_start === 'string'
        ? row.term_start
        : (row.term_start as unknown as Date).toISOString().slice(0, 10),
    termEnd:
      typeof row.term_end === 'string'
        ? row.term_end
        : (row.term_end as unknown as Date).toISOString().slice(0, 10),
    status: row.status as ClassSchedule['status'],
    instructors: instructors
      .filter((item) => item.status !== 'removed')
      .map((item) => ({
        personId: item.person_id,
        name: `${item.first_name} ${item.last_name}`,
        status: item.status as 'pending_compliance' | 'active' | 'removed',
      })),
    sessionCount,
    version: row.version,
  };
}

export class PostgresClassSchedules {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  private async loadInstructors(
    trx: OrgTransaction,
    scheduleIds: readonly string[],
  ): Promise<Map<string, InstructorRow[]>> {
    if (!scheduleIds.length) return new Map();
    const rows = await trx
      .selectFrom('class_instructors as instructor')
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'instructor.org_id')
          .onRef('person.id', '=', 'instructor.person_id'),
      )
      .select([
        'instructor.id',
        'instructor.person_id',
        'instructor.status',
        'instructor.class_schedule_id',
        'person.first_name',
        'person.last_name',
      ])
      .where('instructor.org_id', '=', this.context.orgId)
      .where('instructor.class_schedule_id', 'in', scheduleIds)
      .where('instructor.status', '<>', 'removed')
      .execute();
    const map = new Map<string, InstructorRow[]>();
    for (const row of rows) {
      const list = map.get(row.class_schedule_id) ?? [];
      list.push(row);
      map.set(row.class_schedule_id, list);
    }
    return map;
  }

  async listForOffering(offeringId: string): Promise<ClassSchedule[]> {
    return this.withOrg(this.context, async (trx) => {
      const offering = await trx
        .selectFrom('class_offerings')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', offeringId)
        .executeTakeFirst();
      if (!offering) throw new ClassesNotFoundError('Class offering not found');

      const rows = await trx
        .selectFrom('class_schedules')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('class_offering_id', '=', offeringId)
        .where('status', '<>', 'canceled')
        .orderBy('term_start')
        .execute();
      const instructors = await this.loadInstructors(
        trx,
        rows.map((row) => row.id),
      );
      const spaces = rows.length
        ? await trx
            .selectFrom('spaces')
            .select(['id', 'name'])
            .where('org_id', '=', this.context.orgId)
            .where(
              'id',
              'in',
              rows.flatMap((row) => (row.space_id ? [row.space_id] : [])),
            )
            .execute()
        : [];
      const spaceNames = new Map(spaces.map((row) => [row.id, row.name]));
      const counts = rows.length
        ? await trx
            .selectFrom('class_sessions')
            .select([
              'class_schedule_id',
              sql<number>`count(*)::integer`.as('count'),
            ])
            .where('org_id', '=', this.context.orgId)
            .where(
              'class_schedule_id',
              'in',
              rows.map((row) => row.id),
            )
            .where('holiday_skipped', '=', false)
            .groupBy('class_schedule_id')
            .execute()
        : [];
      const countMap = new Map(
        counts.map((row) => [row.class_schedule_id, row.count]),
      );
      return rows.map((row) =>
        mapSchedule(
          row as unknown as ScheduleRow,
          instructors.get(row.id) ?? [],
          row.space_id ? (spaceNames.get(row.space_id) ?? null) : null,
          countMap.get(row.id) ?? 0,
        ),
      );
    });
  }

  private async getInTransaction(
    trx: OrgTransaction,
    scheduleId: string,
  ): Promise<ClassSchedule> {
    const row = await trx
      .selectFrom('class_schedules')
      .selectAll()
      .where('org_id', '=', this.context.orgId)
      .where('id', '=', scheduleId)
      .executeTakeFirst();
    if (!row) throw new ClassesNotFoundError('Class schedule not found');
    const instructors = await this.loadInstructors(trx, [row.id]);
    const space = row.space_id
      ? await trx
          .selectFrom('spaces')
          .select('name')
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', row.space_id)
          .executeTakeFirst()
      : null;
    const count = await trx
      .selectFrom('class_sessions')
      .select(sql<number>`count(*)::integer`.as('count'))
      .where('org_id', '=', this.context.orgId)
      .where('class_schedule_id', '=', row.id)
      .where('holiday_skipped', '=', false)
      .executeTakeFirstOrThrow();
    return mapSchedule(
      row as unknown as ScheduleRow,
      instructors.get(row.id) ?? [],
      space?.name ?? null,
      count.count,
    );
  }

  async get(scheduleId: string): Promise<ClassSchedule> {
    return this.withOrg(this.context, (trx) =>
      this.getInTransaction(trx, scheduleId),
    );
  }

  async create(
    offeringId: string,
    input: ClassScheduleBody,
    holidays: readonly string[] = [],
  ): Promise<ClassSchedule> {
    const id = newId();
    return this.withOrg(this.context, async (trx) => {
      const offering = await trx
        .selectFrom('class_offerings')
        .select(['id', 'name', 'program_id', 'capacity', 'status'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', offeringId)
        .executeTakeFirst();
      if (!offering || offering.status === 'archived')
        throw new ClassesNotFoundError('Class offering not found');
      if (input.termStart > input.termEnd)
        throw new ClassesConflictError('Term start must precede term end');
      if (input.spaceId) {
        const space = await trx
          .selectFrom('spaces')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', input.spaceId)
          .where('archived_at', 'is', null)
          .executeTakeFirst();
        if (!space) throw new ClassesNotFoundError('Space not found');
      }
      const recurrence = mergeExceptions(input.recurrence, holidays);
      await trx
        .insertInto('class_schedules')
        .values({
          id,
          org_id: this.context.orgId,
          class_offering_id: offeringId,
          recurrence: JSON.stringify(recurrence),
          start_time: input.startTime,
          duration_minutes: input.durationMinutes,
          timezone: input.timezone,
          space_id: input.spaceId,
          location_text: input.locationText,
          term_start: input.termStart,
          term_end: input.termEnd,
          status: 'active',
        })
        .execute();
      await materializeScheduleSessions(
        trx,
        this.context,
        {
          id,
          classOfferingId: offeringId,
          recurrence,
          startTime: input.startTime,
          durationMinutes: input.durationMinutes,
          timezone: input.timezone,
          spaceId: input.spaceId,
          locationText: input.locationText,
          termStart: input.termStart,
          termEnd: input.termEnd,
          title: offering.name,
          programId: offering.program_id,
          capacity: offering.capacity,
        },
        input.termStart,
        input.termEnd,
      );
      await appendAuditEvent(trx, this.context, {
        action: 'classes.schedule_created',
        entityType: 'class_schedule',
        entityId: id,
        changes: {
          offeringId: { tier: 'internal', after: offeringId },
        },
      });
      return this.getInTransaction(trx, id);
    });
  }

  async update(
    scheduleId: string,
    input: ClassScheduleUpdate,
    holidays: readonly string[] = [],
  ): Promise<ClassSchedule> {
    return this.withOrg(this.context, async (trx) => {
      const current = await trx
        .selectFrom('class_schedules')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', scheduleId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new ClassesNotFoundError('Class schedule not found');
      requireVersion(current, input.expectedVersion);
      const offering = await trx
        .selectFrom('class_offerings')
        .select(['id', 'name', 'program_id', 'capacity'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', current.class_offering_id)
        .executeTakeFirstOrThrow();

      const recurrence = input.recurrence
        ? mergeExceptions(input.recurrence, holidays)
        : (current.recurrence as Recurrence);
      const next = {
        recurrence,
        startTime: input.startTime ?? current.start_time.slice(0, 5),
        durationMinutes: input.durationMinutes ?? current.duration_minutes,
        timezone: input.timezone ?? current.timezone,
        spaceId: input.spaceId === undefined ? current.space_id : input.spaceId,
        locationText:
          input.locationText === undefined
            ? current.location_text
            : input.locationText,
        termStart: input.termStart ?? dateOnly(current.term_start),
        termEnd: input.termEnd ?? dateOnly(current.term_end),
      };
      if (next.termStart > next.termEnd)
        throw new ClassesConflictError('Term start must precede term end');
      await trx
        .updateTable('class_schedules')
        .set({
          recurrence: JSON.stringify(next.recurrence),
          start_time: next.startTime,
          duration_minutes: next.durationMinutes,
          timezone: next.timezone,
          space_id: next.spaceId,
          location_text: next.locationText,
          term_start: next.termStart,
          term_end: next.termEnd,
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', scheduleId)
        .execute();

      if (input.regenerate) {
        const now = new Date();
        const removable = await sql<{ session_id: string; event_id: string }>`
          SELECT session.id AS session_id, session.event_id
          FROM class_sessions session
          JOIN events event
            ON event.org_id = session.org_id AND event.id = session.event_id
          WHERE session.org_id = ${this.context.orgId}::uuid
            AND session.class_schedule_id = ${scheduleId}::uuid
            AND event.starts_at > ${now.toISOString()}::timestamptz
            AND NOT EXISTS (
              SELECT 1 FROM attendance a
              WHERE a.org_id = session.org_id AND a.event_id = session.event_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM class_session_bookings booking
              WHERE booking.org_id = session.org_id
                AND booking.class_session_id = session.id
                AND booking.status IN ('booked', 'attended')
            )
          FOR UPDATE OF session
        `.execute(trx);
        const sessionIds = removable.rows.map((row) => row.session_id);
        const eventIds = removable.rows.map((row) => row.event_id);
        if (sessionIds.length) {
          await trx
            .deleteFrom('class_sessions')
            .where('org_id', '=', this.context.orgId)
            .where('id', 'in', sessionIds)
            .execute();
          await trx
            .deleteFrom('events')
            .where('org_id', '=', this.context.orgId)
            .where('id', 'in', eventIds)
            .execute();
        }
        const orgToday = new Intl.DateTimeFormat('en-CA', {
          timeZone: next.timezone,
        }).format(now);
        await materializeScheduleSessions(
          trx,
          this.context,
          {
            id: scheduleId,
            classOfferingId: offering.id,
            recurrence: next.recurrence,
            startTime: next.startTime,
            durationMinutes: next.durationMinutes,
            timezone: next.timezone,
            spaceId: next.spaceId,
            locationText: next.locationText,
            termStart: next.termStart,
            termEnd: next.termEnd,
            title: offering.name,
            programId: offering.program_id,
            capacity: offering.capacity,
          },
          orgToday,
          next.termEnd,
        );
        await appendAuditEvent(trx, this.context, {
          action: 'classes.schedule_regenerated',
          entityType: 'class_schedule',
          entityId: scheduleId,
          changes: {
            removedSessions: { tier: 'internal', after: removable.rows.length },
          },
        });
      }
      await appendAuditEvent(trx, this.context, {
        action: 'classes.schedule_updated',
        entityType: 'class_schedule',
        entityId: scheduleId,
        changes: {},
      });
      return this.getInTransaction(trx, scheduleId);
    });
  }

  async end(scheduleId: string, expectedVersion: number): Promise<void> {
    return this.withOrg(this.context, async (trx) => {
      const current = await trx
        .selectFrom('class_schedules')
        .select(['version', 'status'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', scheduleId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new ClassesNotFoundError('Class schedule not found');
      requireVersion(current, expectedVersion);
      if (current.status !== 'active')
        throw new ClassesConflictError('Schedule is already ended');
      await trx
        .updateTable('class_schedules')
        .set({ status: 'ended', version: sql`version + 1` })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', scheduleId)
        .execute();
      await trx
        .updateTable('events')
        .set({ status: 'canceled', status_reason: 'Schedule ended' })
        .where('org_id', '=', this.context.orgId)
        .where('kind', '=', 'class_session')
        .where('starts_at', '>', sql<Date>`now()`)
        .where('status', '=', 'scheduled')
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('class_sessions')
            .select('event_id')
            .where('org_id', '=', this.context.orgId)
            .where('class_schedule_id', '=', scheduleId),
        )
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.schedule_ended',
        entityType: 'class_schedule',
        entityId: scheduleId,
        changes: {},
      });
    });
  }

  async assignInstructor(
    scheduleId: string,
    input: InstructorAssign,
  ): Promise<{ id: string; status: string; missing: ComplianceMissing[] }> {
    return this.withOrg(this.context, async (trx) => {
      const schedule = await trx
        .selectFrom('class_schedules')
        .select(['id', 'class_offering_id', 'status'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', scheduleId)
        .forUpdate()
        .executeTakeFirst();
      if (!schedule || schedule.status === 'canceled')
        throw new ClassesNotFoundError('Class schedule not found');
      const offering = await trx
        .selectFrom('class_offerings')
        .select('program_id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', schedule.class_offering_id)
        .executeTakeFirstOrThrow();
      const person = await trx
        .selectFrom('people')
        .select(['id', 'date_of_birth'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', input.personId)
        .executeTakeFirst();
      if (!person) throw new ClassesNotFoundError('Instructor not found');

      const eligibility = await evaluateRoleEligibility(
        trx,
        this.context,
        {
          personId: input.personId,
          role: 'head_coach',
          programId: offering.program_id,
        },
        new Date(),
      );
      const status = eligibility.eligible ? 'active' : 'pending_compliance';
      const existing = await trx
        .selectFrom('class_instructors')
        .select(['id', 'status'])
        .where('org_id', '=', this.context.orgId)
        .where('class_schedule_id', '=', scheduleId)
        .where('person_id', '=', input.personId)
        .executeTakeFirst();
      let id: string;
      if (existing) {
        id = existing.id;
        await trx
          .updateTable('class_instructors')
          .set({ status, updated_at: sql`now()` })
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', existing.id)
          .execute();
      } else {
        id = newId();
        await trx
          .insertInto('class_instructors')
          .values({
            id,
            org_id: this.context.orgId,
            class_schedule_id: scheduleId,
            person_id: input.personId,
            status,
            added_by: this.context.actor.accountId,
          })
          .execute();
      }
      await appendAuditEvent(trx, this.context, {
        action: 'classes.instructor_assigned',
        entityType: 'class_schedule',
        entityId: scheduleId,
        changes: {
          personId: { tier: 'internal', after: input.personId },
          status: { tier: 'internal', after: status },
        },
      });
      return {
        id,
        status,
        missing: eligibility.missing,
      };
    });
  }

  async removeInstructor(scheduleId: string, personId: string): Promise<void> {
    return this.withOrg(this.context, async (trx) => {
      const updated = await trx
        .updateTable('class_instructors')
        .set({ status: 'removed', updated_at: sql`now()` })
        .where('org_id', '=', this.context.orgId)
        .where('class_schedule_id', '=', scheduleId)
        .where('person_id', '=', personId)
        .where('status', '<>', 'removed')
        .returning('id')
        .execute();
      if (!updated.length)
        throw new ClassesNotFoundError('Instructor assignment not found');
      await appendAuditEvent(trx, this.context, {
        action: 'classes.instructor_removed',
        entityType: 'class_schedule',
        entityId: scheduleId,
        changes: { personId: { tier: 'internal', after: personId } },
      });
    });
  }

  async instructorRoster(scheduleId: string): Promise<
    {
      personId: string;
      name: string;
      status: string;
      eligible: boolean;
      missing: ComplianceMissing[];
    }[]
  > {
    return this.withOrg(this.context, async (trx) => {
      const schedule = await trx
        .selectFrom('class_schedules')
        .select(['class_offering_id'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', scheduleId)
        .executeTakeFirst();
      if (!schedule) throw new ClassesNotFoundError('Class schedule not found');
      const offering = await trx
        .selectFrom('class_offerings')
        .select('program_id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', schedule.class_offering_id)
        .executeTakeFirstOrThrow();
      const rows = await trx
        .selectFrom('class_instructors as instructor')
        .innerJoin('people as person', (join) =>
          join
            .onRef('person.org_id', '=', 'instructor.org_id')
            .onRef('person.id', '=', 'instructor.person_id'),
        )
        .select([
          'instructor.person_id',
          'instructor.status',
          'person.first_name',
          'person.last_name',
        ])
        .where('instructor.org_id', '=', this.context.orgId)
        .where('instructor.class_schedule_id', '=', scheduleId)
        .where('instructor.status', '<>', 'removed')
        .execute();
      const roster: {
        personId: string;
        name: string;
        status: string;
        eligible: boolean;
        missing: ComplianceMissing[];
      }[] = [];
      for (const row of rows) {
        let eligible = false;
        let missing: ComplianceMissing[] = [];
        try {
          const result = await evaluateRoleEligibility(
            trx,
            this.context,
            {
              personId: row.person_id,
              role: 'head_coach',
              programId: offering.program_id,
            },
            new Date(),
          );
          eligible = result.eligible;
          missing = result.missing;
        } catch (error) {
          if (error instanceof RoleEligibilityError) {
            eligible = false;
            missing = error.result.missing;
          }
        }
        roster.push({
          personId: row.person_id,
          name: `${row.first_name} ${row.last_name}`,
          status: row.status,
          eligible,
          missing,
        });
      }
      return roster;
    });
  }
}

function mergeExceptions(
  recurrence: Recurrence,
  holidays: readonly string[],
): Recurrence {
  if (!holidays.length || recurrence.kind === 'once') return recurrence;
  const parsed = z.iso.date().array().parse(holidays);
  const merged = new Set([...(recurrence.exceptions ?? []), ...parsed]);
  return { ...recurrence, exceptions: [...merged].sort() };
}

function dateOnly(value: string | Date): string {
  return typeof value === 'string'
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}
