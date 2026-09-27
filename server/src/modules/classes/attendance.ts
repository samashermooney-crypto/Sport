import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import type { MarkAttendanceBody } from '@shared/schemas/classes';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import { ClassesConflictError, ClassesNotFoundError } from './errors.js';

const makeupPolicySchema = z.strictObject({
  creditsPerTerm: z.number().int().nonnegative().default(0),
  expiryDays: z.number().int().positive().default(90),
  eligibleLevelIds: z.array(z.uuid()).nullable().default(null),
  eligibleOfferingIds: z.array(z.uuid()).nullable().default(null),
});

interface SessionContext {
  session_id: string;
  event_id: string;
  class_offering_id: string;
  class_schedule_id: string;
  offering_name: string;
  status: string;
  makeup_policy: unknown;
  term_start: string | null;
  term_end: string | null;
  event_date: string;
}

async function loadSession(
  trx: OrgTransaction,
  orgId: string,
  classSessionId: string,
): Promise<SessionContext> {
  const rows = await sql<SessionContext>`
    SELECT session.id AS session_id, session.event_id,
      session.class_offering_id, session.class_schedule_id,
      offering.name AS offering_name, event.status,
      offering.makeup_policy,
      schedule.term_start::text, schedule.term_end::text,
      (event.starts_at AT TIME ZONE event.timezone)::date::text AS event_date
    FROM class_sessions session
    JOIN events event ON event.org_id = session.org_id
      AND event.id = session.event_id
    JOIN class_offerings offering ON offering.org_id = session.org_id
      AND offering.id = session.class_offering_id
    JOIN class_schedules schedule ON schedule.org_id = session.org_id
      AND schedule.id = session.class_schedule_id
    WHERE session.org_id = ${orgId}::uuid
      AND session.id = ${classSessionId}::uuid
  `.execute(trx);
  const row = rows.rows[0];
  if (!row) throw new ClassesNotFoundError('Class session not found');
  return row;
}

/** Write (or upsert) an attendance row with a roster snapshot on first write. */
async function upsertAttendance(
  trx: OrgTransaction,
  context: OrgContext,
  session: SessionContext,
  personId: string,
  status: 'present' | 'absent' | 'late' | 'excused' | 'unknown',
): Promise<void> {
  const existing = await trx
    .selectFrom('attendance')
    .select(['id', 'roster_snapshot'])
    .where('org_id', '=', context.orgId)
    .where('event_id', '=', session.event_id)
    .where('person_id', '=', personId)
    .executeTakeFirst();
  if (existing) {
    await trx
      .updateTable('attendance')
      .set({ status, version: sql`version + 1`, updated_at: sql`now()` })
      .where('org_id', '=', context.orgId)
      .where('id', '=', existing.id)
      .execute();
    return;
  }
  const snapshot = await sql<{ members: unknown }>`
    SELECT coalesce(jsonb_agg(member), '[]'::jsonb) AS members
    FROM (
      SELECT jsonb_build_object(
        'personId', enrollment.person_id, 'membership', 'enrolled') AS member
      FROM class_enrollments enrollment
      JOIN class_sessions session ON session.org_id = enrollment.org_id
        AND session.id = ${session.session_id}::uuid
      JOIN events event ON event.org_id = session.org_id
        AND event.id = session.event_id
      WHERE enrollment.org_id = ${context.orgId}::uuid
        AND enrollment.class_offering_id = session.class_offering_id
        AND enrollment.status IN ('trial', 'active')
        AND enrollment.starts_on <= (event.starts_at AT TIME ZONE event.timezone)::date
        AND (enrollment.ends_on IS NULL OR enrollment.ends_on >=
          (event.starts_at AT TIME ZONE event.timezone)::date)
      UNION ALL
      SELECT jsonb_build_object(
        'personId', booking.person_id, 'membership', booking.kind)
      FROM class_session_bookings booking
      WHERE booking.org_id = ${context.orgId}::uuid
        AND booking.class_session_id = ${session.session_id}::uuid
        AND booking.status IN ('booked', 'attended')
    ) roster
  `.execute(trx);
  await trx
    .insertInto('attendance')
    .values({
      id: newId(),
      org_id: context.orgId,
      event_id: session.event_id,
      person_id: personId,
      status,
      roster_snapshot: sql`${JSON.stringify(snapshot.rows[0]?.members ?? [])}::jsonb`,
    })
    .execute();
}

/** Grant a make-up credit when policy allows and the term cap isn't hit. */
async function maybeGrantMakeupCredit(
  trx: OrgTransaction,
  context: OrgContext,
  session: SessionContext,
  personId: string,
): Promise<boolean> {
  const policy = makeupPolicySchema.parse(session.makeup_policy ?? {});
  if (policy.creditsPerTerm <= 0) return false;
  const enrolled = await trx
    .selectFrom('class_enrollments')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('class_offering_id', '=', session.class_offering_id)
    .where('person_id', '=', personId)
    .where('status', 'in', ['trial', 'active', 'paused'])
    .executeTakeFirst();
  if (!enrolled) return false;
  const termStart = session.term_start ?? session.event_date;
  const termEnd = session.term_end ?? session.event_date;
  const issued = await sql<{ count: number }>`
    SELECT count(*)::integer AS count
    FROM makeup_credits credit
    JOIN events source ON source.org_id = credit.org_id
      AND source.id = credit.source_event_id
    WHERE credit.org_id = ${context.orgId}::uuid
      AND credit.person_id = ${personId}::uuid
      AND credit.class_offering_id = ${session.class_offering_id}::uuid
      AND (source.starts_at AT TIME ZONE source.timezone)::date
        BETWEEN ${termStart}::date AND ${termEnd}::date
  `.execute(trx);
  if ((issued.rows[0]?.count ?? 0) >= policy.creditsPerTerm) return false;
  const expiresOn = Temporal.PlainDate.from(session.event_date)
    .add({ days: policy.expiryDays })
    .toString();
  const id = newId();
  const inserted = await trx
    .insertInto('makeup_credits')
    .values({
      id,
      org_id: context.orgId,
      person_id: personId,
      class_offering_id: session.class_offering_id,
      source_event_id: session.event_id,
      expires_on: expiresOn,
      status: 'available',
    })
    .onConflict((conflict) =>
      conflict.columns(['org_id', 'person_id', 'source_event_id']).doNothing(),
    )
    .returning('id')
    .execute();
  if (!inserted.length) return false;
  await appendAuditEvent(trx, context, {
    action: 'classes.makeup_credit_issued',
    entityType: 'makeup_credit',
    entityId: id,
    changes: {
      personId: { tier: 'internal', after: personId },
      sourceEventId: { tier: 'internal', after: session.event_id },
    },
  });
  return true;
}

export class PostgresClassAttendance {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async mark(
    classSessionId: string,
    input: MarkAttendanceBody,
  ): Promise<{ marked: number; creditsIssued: number }> {
    return this.withOrg(this.context, async (trx) => {
      const session = await loadSession(
        trx,
        this.context.orgId,
        classSessionId,
      );
      let credits = 0;
      for (const mark of input.marks) {
        const person = await trx
          .selectFrom('people')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', mark.personId)
          .executeTakeFirst();
        if (!person) throw new ClassesNotFoundError('Roster person not found');
        await upsertAttendance(
          trx,
          this.context,
          session,
          mark.personId,
          mark.status,
        );
        if (mark.status === 'absent' || mark.status === 'excused') {
          if (
            await maybeGrantMakeupCredit(
              trx,
              this.context,
              session,
              mark.personId,
            )
          )
            credits += 1;
        }
        if (mark.status === 'present' || mark.status === 'late') {
          await trx
            .updateTable('class_session_bookings')
            .set({ status: 'attended', version: sql`version + 1` })
            .where('org_id', '=', this.context.orgId)
            .where('class_session_id', '=', classSessionId)
            .where('person_id', '=', mark.personId)
            .where('status', '=', 'booked')
            .execute();
        }
        if (mark.status === 'absent') {
          await trx
            .updateTable('class_session_bookings')
            .set({ status: 'no_show', version: sql`version + 1` })
            .where('org_id', '=', this.context.orgId)
            .where('class_session_id', '=', classSessionId)
            .where('person_id', '=', mark.personId)
            .where('status', '=', 'booked')
            .execute();
        }
      }
      await appendAuditEvent(trx, this.context, {
        action: 'classes.attendance_marked',
        entityType: 'class_session',
        entityId: classSessionId,
        changes: {
          count: { tier: 'internal', after: input.marks.length },
          creditsIssued: { tier: 'internal', after: credits },
        },
      });
      return { marked: input.marks.length, creditsIssued: credits };
    });
  }

  async checkIn(
    classSessionId: string,
    personId: string,
  ): Promise<{ checkedInAt: string }> {
    return this.withOrg(this.context, async (trx) => {
      const session = await loadSession(
        trx,
        this.context.orgId,
        classSessionId,
      );
      await upsertAttendance(trx, this.context, session, personId, 'present');
      const now = new Date();
      await trx
        .updateTable('attendance')
        .set({
          checked_in_at: now,
          checked_in_by: this.context.actor.accountId,
          status: 'present',
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('event_id', '=', session.event_id)
        .where('person_id', '=', personId)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.checked_in',
        entityType: 'attendance',
        entityId: session.event_id,
        changes: { personId: { tier: 'restricted', after: personId } },
      });
      return { checkedInAt: now.toISOString() };
    });
  }

  /**
   * Check out an athlete. The picking-up person must be an authorized pickup:
   * a household member flagged can_pick_up or a verified guardian link.
   */
  async checkOut(
    classSessionId: string,
    personId: string,
    pickedUpByPersonId: string,
  ): Promise<{ checkedOutAt: string; pickedUpBy: string }> {
    return this.withOrg(this.context, async (trx) => {
      const session = await loadSession(
        trx,
        this.context.orgId,
        classSessionId,
      );
      const athlete = await trx
        .selectFrom('people')
        .select(['id', 'first_name', 'last_name'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', personId)
        .executeTakeFirst();
      if (!athlete) throw new ClassesNotFoundError('Athlete not found');
      const authorized = await sql<{ name: string }>`
        SELECT person.first_name || ' ' || person.last_name AS name
        FROM people person
        WHERE person.org_id = ${this.context.orgId}::uuid
          AND person.id = ${pickedUpByPersonId}::uuid
          AND (
            EXISTS (
              SELECT 1 FROM household_members member
              JOIN household_members athlete_member
                ON athlete_member.org_id = member.org_id
                AND athlete_member.household_id = member.household_id
                AND athlete_member.person_id = ${personId}::uuid
                AND athlete_member.removed_at IS NULL
              WHERE member.org_id = ${this.context.orgId}::uuid
                AND member.person_id = person.id
                AND member.can_pick_up = true
                AND member.removed_at IS NULL
            )
            OR EXISTS (
              SELECT 1 FROM person_account_links picker_link
              JOIN person_account_links guardian_link
                ON guardian_link.org_id = picker_link.org_id
                AND guardian_link.account_id = picker_link.account_id
              WHERE picker_link.org_id = ${this.context.orgId}::uuid
                AND picker_link.person_id = person.id
                AND picker_link.verified_at IS NOT NULL
                AND picker_link.revoked_at IS NULL
                AND guardian_link.person_id = ${personId}::uuid
                AND guardian_link.relationship = 'guardian'
                AND guardian_link.verified_at IS NOT NULL
                AND guardian_link.revoked_at IS NULL
            )
          )
      `.execute(trx);
      const pickup = authorized.rows[0];
      if (!pickup)
        throw new ClassesConflictError(
          'This person is not an authorized pickup for the athlete',
          'PICKUP_UNAUTHORIZED',
        );
      const now = new Date();
      await upsertAttendance(trx, this.context, session, personId, 'present');
      await trx
        .updateTable('attendance')
        .set({
          checked_out_at: now,
          picked_up_by_person_id: pickedUpByPersonId,
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('event_id', '=', session.event_id)
        .where('person_id', '=', personId)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.checked_out',
        entityType: 'attendance',
        entityId: session.event_id,
        changes: {
          personId: { tier: 'restricted', after: personId },
          pickedUpBy: { tier: 'restricted', after: pickedUpByPersonId },
        },
      });
      return { checkedOutAt: now.toISOString(), pickedUpBy: pickup.name };
    });
  }
}
