import type { ClassSession, SessionRoster } from '@shared/schemas/classes';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import { ClassesNotFoundError } from './errors.js';

interface SessionRow {
  session_id: string;
  event_id: string;
  class_offering_id: string;
  class_schedule_id: string;
  offering_name: string;
  level_name: string | null;
  title: string;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  space_id: string | null;
  space_name: string | null;
  location_text: string | null;
  status: string;
  capacity: number;
  enrolled_count: number;
  booked_count: number;
  substitute_person_id: string | null;
  instructor_names: string | null;
}

const SESSION_SELECT = `
  SELECT session.id AS session_id, session.event_id,
    session.class_offering_id, session.class_schedule_id,
    offering.name AS offering_name, level.name AS level_name,
    event.title, event.starts_at, event.ends_at, event.timezone,
    event.space_id, space.name AS space_name,
    COALESCE(session.capacity, offering.capacity) AS capacity,
    event.location_text,
    event.status,
    session.substitute_person_id,
    (SELECT count(*)::integer FROM class_enrollments enrollment
      WHERE enrollment.org_id = session.org_id
        AND enrollment.class_offering_id = session.class_offering_id
        AND enrollment.status IN ('trial', 'active')
        AND enrollment.starts_on <= (event.starts_at AT TIME ZONE event.timezone)::date
        AND (enrollment.ends_on IS NULL
          OR enrollment.ends_on >= (event.starts_at AT TIME ZONE event.timezone)::date)
        AND (enrollment.pause_from IS NULL
          OR enrollment.pause_to IS NULL
          OR (event.starts_at AT TIME ZONE event.timezone)::date
            NOT BETWEEN enrollment.pause_from AND enrollment.pause_to)
    ) AS enrolled_count,
    (SELECT count(*)::integer FROM class_session_bookings booking
      WHERE booking.org_id = session.org_id
        AND booking.class_session_id = session.id
        AND booking.status IN ('booked', 'attended')) AS booked_count,
    (SELECT string_agg(person.first_name || ' ' || person.last_name, ', ')
      FROM class_instructors instructor
      JOIN people person ON person.org_id = instructor.org_id
        AND person.id = instructor.person_id
      WHERE instructor.org_id = session.org_id
        AND instructor.class_schedule_id = session.class_schedule_id
        AND instructor.status = 'active') AS instructor_names
  FROM class_sessions session
  JOIN events event ON event.org_id = session.org_id AND event.id = session.event_id
  JOIN class_offerings offering
    ON offering.org_id = session.org_id AND offering.id = session.class_offering_id
  LEFT JOIN skill_levels level
    ON level.org_id = offering.org_id AND level.id = offering.skill_level_id
  LEFT JOIN spaces space ON space.org_id = event.org_id AND space.id = event.space_id
`;

function mapSession(row: SessionRow): ClassSession {
  const spots = Math.max(
    0,
    row.capacity - row.enrolled_count - row.booked_count,
  );
  return {
    id: row.session_id,
    eventId: row.event_id,
    classOfferingId: row.class_offering_id,
    classScheduleId: row.class_schedule_id,
    offeringName: row.offering_name,
    levelName: row.level_name,
    title: row.title,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    localDate: z.iso
      .date()
      .parse(
        new Intl.DateTimeFormat('en-CA', { timeZone: row.timezone }).format(
          row.starts_at,
        ),
      ),
    timezone: row.timezone,
    spaceId: row.space_id,
    spaceName: row.space_name,
    locationText: row.location_text,
    status: row.status as ClassSession['status'],
    capacity: row.capacity,
    enrolledCount: row.enrolled_count,
    bookedCount: row.booked_count,
    spotsRemaining: spots,
    instructorNames: row.instructor_names
      ? row.instructor_names.split(', ')
      : [],
    substitutePersonId: row.substitute_person_id,
  };
}

export class PostgresClassSessions {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async list(input: {
    offeringId?: string;
    scheduleId?: string;
    from: string;
    to: string;
    limit: number;
  }): Promise<ClassSession[]> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<SessionRow>`
        ${sql.raw(SESSION_SELECT)}
        WHERE session.org_id = ${this.context.orgId}::uuid
          AND event.starts_at >= ${input.from}::timestamptz
          AND event.starts_at <= ${input.to}::timestamptz
          AND session.holiday_skipped = false
          ${input.offeringId ? sql`AND session.class_offering_id = ${input.offeringId}::uuid` : sql``}
          ${input.scheduleId ? sql`AND session.class_schedule_id = ${input.scheduleId}::uuid` : sql``}
        ORDER BY event.starts_at
        LIMIT ${input.limit}
      `.execute(trx);
      return rows.rows.map(mapSession);
    });
  }

  async get(classSessionId: string): Promise<ClassSession> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<SessionRow>`
        ${sql.raw(SESSION_SELECT)}
        WHERE session.org_id = ${this.context.orgId}::uuid
          AND session.id = ${classSessionId}::uuid
      `.execute(trx);
      const row = rows.rows[0];
      if (!row) throw new ClassesNotFoundError('Class session not found');
      return mapSession(row);
    });
  }

  async getByEventId(eventId: string): Promise<ClassSession> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<SessionRow>`
        ${sql.raw(SESSION_SELECT)}
        WHERE session.org_id = ${this.context.orgId}::uuid
          AND session.event_id = ${eventId}::uuid
      `.execute(trx);
      const row = rows.rows[0];
      if (!row) throw new ClassesNotFoundError('Class session not found');
      return mapSession(row);
    });
  }

  async roster(
    trx: OrgTransaction,
    classSessionId: string,
  ): Promise<SessionRoster> {
    const sessionRows = await sql<SessionRow>`
      ${sql.raw(SESSION_SELECT)}
      WHERE session.org_id = ${this.context.orgId}::uuid
        AND session.id = ${classSessionId}::uuid
    `.execute(trx);
    const session = sessionRows.rows[0];
    if (!session) throw new ClassesNotFoundError('Class session not found');

    const enrolled = await sql<{
      person_id: string;
      first_name: string;
      last_name: string;
      membership: string;
      attendance_status: string | null;
      checked_in_at: Date | null;
      checked_out_at: Date | null;
      picked_up_by_name: string | null;
    }>`
      SELECT person.id AS person_id, person.first_name, person.last_name,
        'enrolled' AS membership,
        attendance.status AS attendance_status,
        attendance.checked_in_at, attendance.checked_out_at,
        picked.first_name || ' ' || picked.last_name AS picked_up_by_name
      FROM class_enrollments enrollment
      JOIN people person ON person.org_id = enrollment.org_id
        AND person.id = enrollment.person_id
      JOIN class_sessions session ON session.org_id = enrollment.org_id
        AND session.id = ${classSessionId}::uuid
      JOIN events event ON event.org_id = session.org_id
        AND event.id = session.event_id
      LEFT JOIN attendance ON attendance.org_id = enrollment.org_id
        AND attendance.event_id = event.id
        AND attendance.person_id = enrollment.person_id
      LEFT JOIN people picked ON picked.org_id = attendance.org_id
        AND picked.id = attendance.picked_up_by_person_id
      WHERE enrollment.org_id = ${this.context.orgId}::uuid
        AND enrollment.class_offering_id = session.class_offering_id
        AND enrollment.status IN ('trial', 'active')
        AND enrollment.starts_on <= (event.starts_at AT TIME ZONE event.timezone)::date
        AND (enrollment.ends_on IS NULL
          OR enrollment.ends_on >= (event.starts_at AT TIME ZONE event.timezone)::date)
        AND (enrollment.pause_from IS NULL
          OR enrollment.pause_to IS NULL
          OR (event.starts_at AT TIME ZONE event.timezone)::date
            NOT BETWEEN enrollment.pause_from AND enrollment.pause_to)
      UNION ALL
      SELECT person.id AS person_id, person.first_name, person.last_name,
        booking.kind AS membership,
        attendance.status AS attendance_status,
        attendance.checked_in_at, attendance.checked_out_at,
        picked.first_name || ' ' || picked.last_name AS picked_up_by_name
      FROM class_session_bookings booking
      JOIN people person ON person.org_id = booking.org_id
        AND person.id = booking.person_id
      JOIN class_sessions session ON session.org_id = booking.org_id
        AND session.id = booking.class_session_id
      LEFT JOIN attendance ON attendance.org_id = booking.org_id
        AND attendance.event_id = session.event_id
        AND attendance.person_id = booking.person_id
      LEFT JOIN people picked ON picked.org_id = attendance.org_id
        AND picked.id = attendance.picked_up_by_person_id
      WHERE booking.org_id = ${this.context.orgId}::uuid
        AND booking.class_session_id = ${classSessionId}::uuid
        AND booking.status IN ('booked', 'attended')
      ORDER BY last_name, first_name
    `.execute(trx);

    const attendees = [] as SessionRoster['attendees'];
    for (const row of enrolled.rows) {
      const pickups = await trx
        .selectFrom('person_account_links as link')
        .innerJoin('accounts as account', 'account.id', 'link.account_id')
        .select([
          sql<string>`account.first_name || ' ' || account.last_name`.as(
            'name',
          ),
        ])
        .where('link.org_id', '=', this.context.orgId)
        .where('link.person_id', '=', row.person_id)
        .where('link.relationship', '=', 'guardian')
        .where('link.verified_at', 'is not', null)
        .where('link.revoked_at', 'is', null)
        .execute();
      attendees.push({
        personId: row.person_id,
        personName: `${row.first_name} ${row.last_name}`,
        membership:
          row.membership as SessionRoster['attendees'][number]['membership'],
        status: (row.attendance_status ??
          'unknown') as SessionRoster['attendees'][number]['status'],
        checkedInAt: row.checked_in_at?.toISOString() ?? null,
        checkedOutAt: row.checked_out_at?.toISOString() ?? null,
        pickedUpByName: row.picked_up_by_name,
        canPickUp: pickups.map((pickup) => pickup.name),
      });
    }
    return { session: mapSession(session), attendees };
  }

  async cancel(classSessionId: string, reason: string | null): Promise<void> {
    return this.withOrg(this.context, async (trx) => {
      const session = await trx
        .selectFrom('class_sessions')
        .select(['id', 'event_id'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', classSessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!session) throw new ClassesNotFoundError('Class session not found');
      await trx
        .updateTable('events')
        .set({ status: 'canceled', status_reason: reason })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', session.event_id)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.session_canceled',
        entityType: 'class_session',
        entityId: classSessionId,
        changes: { reason: { tier: 'internal', after: reason } },
      });
    });
  }
}
