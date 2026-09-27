import type { AcademyDashboard } from '@shared/schemas/classes';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

export class PostgresAcademyDashboard {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async get(): Promise<AcademyDashboard> {
    return this.withOrg(this.context, async (trx) => {
      const byLevel = await sql<{
        level_id: string | null;
        level_name: string;
        active_enrollments: number;
        capacity: number;
      }>`
        SELECT level.id AS level_id,
          COALESCE(level.name, 'Unassigned') AS level_name,
          count(enrollment.id)::integer AS active_enrollments,
          COALESCE(sum(offering.capacity), 0)::integer AS capacity
        FROM class_offerings offering
        LEFT JOIN skill_levels level ON level.org_id = offering.org_id
          AND level.id = offering.skill_level_id
        LEFT JOIN class_enrollments enrollment
          ON enrollment.org_id = offering.org_id
          AND enrollment.class_offering_id = offering.id
          AND enrollment.status IN ('trial', 'active', 'paused')
        WHERE offering.org_id = ${this.context.orgId}::uuid
          AND offering.status = 'active'
        GROUP BY level.id, level.name
        ORDER BY level.sort_order NULLS LAST, level_name
      `.execute(trx);

      const byClass = await sql<{
        id: string;
        name: string;
        level_name: string | null;
        enrolled: number;
        capacity: number;
      }>`
        SELECT offering.id, offering.name, level.name AS level_name,
          (SELECT count(*)::integer FROM class_enrollments e
            WHERE e.org_id = offering.org_id AND e.class_offering_id = offering.id
              AND e.status IN ('trial', 'active', 'paused')) AS enrolled,
          offering.capacity
        FROM class_offerings offering
        LEFT JOIN skill_levels level ON level.org_id = offering.org_id
          AND level.id = offering.skill_level_id
        WHERE offering.org_id = ${this.context.orgId}::uuid
          AND offering.status <> 'archived'
        ORDER BY offering.name
      `.execute(trx);

      const heatmap = await sql<{
        weekday: number;
        start_hour: number;
        enrolled_count: number;
        capacity: number;
      }>`
        SELECT extract(isodow FROM (event.starts_at AT TIME ZONE event.timezone))::integer AS weekday,
          extract(hour FROM (event.starts_at AT TIME ZONE event.timezone))::integer AS start_hour,
          (SELECT count(*)::integer FROM class_enrollments e
            WHERE e.org_id = session.org_id
              AND e.class_offering_id = session.class_offering_id
              AND e.status IN ('trial', 'active')) AS enrolled_count,
          COALESCE(session.capacity, offering.capacity)::integer AS capacity
        FROM class_sessions session
        JOIN events event ON event.org_id = session.org_id
          AND event.id = session.event_id
        JOIN class_offerings offering ON offering.org_id = session.org_id
          AND offering.id = session.class_offering_id
        WHERE session.org_id = ${this.context.orgId}::uuid
          AND session.holiday_skipped = false
          AND event.status = 'scheduled'
          AND event.starts_at > now()
          AND event.starts_at < now() + interval '28 days'
      `.execute(trx);

      const churn = await sql<{
        month: string;
        withdrawals: number;
        enrollments: number;
      }>`
        SELECT to_char(months.month, 'YYYY-MM') AS month,
          COALESCE(withdrawn.count, 0)::integer AS withdrawals,
          COALESCE(started.count, 0)::integer AS enrollments
        FROM generate_series(
          date_trunc('month', now()) - interval '11 months',
          date_trunc('month', now()), interval '1 month') months(month)
        LEFT JOIN (
          SELECT date_trunc('month', withdrawn_at) AS month,
            count(*)::integer AS count
          FROM class_enrollments
          WHERE org_id = ${this.context.orgId}::uuid AND withdrawn_at IS NOT NULL
          GROUP BY 1
        ) withdrawn ON withdrawn.month = months.month
        LEFT JOIN (
          SELECT date_trunc('month', created_at) AS month,
            count(*)::integer AS count
          FROM class_enrollments
          WHERE org_id = ${this.context.orgId}::uuid
            AND status <> 'trial'
          GROUP BY 1
        ) started ON started.month = months.month
        ORDER BY months.month
      `.execute(trx);

      const money = await sql<{
        mrr_cents: number;
        active_subscriptions: number;
        failed_payments: number;
      }>`
        SELECT
          COALESCE((
            SELECT sum(line.amount_cents)::integer
            FROM tuition_invoices link
            JOIN invoices invoice ON invoice.org_id = link.org_id
              AND invoice.id = link.invoice_id
            JOIN invoice_lines line ON line.org_id = invoice.org_id
              AND line.invoice_id = invoice.id
            WHERE link.org_id = ${this.context.orgId}::uuid
              AND line.kind = 'tuition'
              AND invoice.status IN ('open', 'paid', 'partially_paid')
              AND invoice.issued_at > now() - interval '35 days'
          ), 0)::bigint AS mrr_cents,
          (SELECT count(*)::integer FROM tuition_subscriptions sub
            WHERE sub.org_id = ${this.context.orgId}::uuid
              AND sub.status = 'active') AS active_subscriptions,
          (SELECT count(*)::integer FROM installments inst
            WHERE inst.org_id = ${this.context.orgId}::uuid
              AND inst.status = 'failed'
              AND inst.updated_at > now() - interval '30 days'
              AND inst.invoice_id IN (
                SELECT invoice_id FROM tuition_invoices
                WHERE org_id = ${this.context.orgId}::uuid
              )) AS failed_payments
      `.execute(trx);

      const makeups = await trx
        .selectFrom('makeup_credits')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('org_id', '=', this.context.orgId)
        .where('status', '=', 'available')
        .executeTakeFirstOrThrow();

      const ratioWarnings = await sql<{
        session_id: string;
        event_id: string;
        offering_name: string;
        starts_at: Date;
        attendees: number;
        instructors: number;
        required_instructors: number;
      }>`
        SELECT session.id AS session_id, session.event_id,
          offering.name AS offering_name, event.starts_at,
          (SELECT count(*)::integer FROM class_enrollments e
            WHERE e.org_id = session.org_id
              AND e.class_offering_id = session.class_offering_id
              AND e.status IN ('trial', 'active')
              AND e.starts_on <= (event.starts_at AT TIME ZONE event.timezone)::date
              AND (e.ends_on IS NULL OR e.ends_on >=
                (event.starts_at AT TIME ZONE event.timezone)::date)
          ) +
          (SELECT count(*)::integer FROM class_session_bookings b
            WHERE b.org_id = session.org_id
              AND b.class_session_id = session.id
              AND b.status IN ('booked', 'attended')) AS attendees,
          (SELECT count(*)::integer FROM class_instructors instructor
            WHERE instructor.org_id = session.org_id
              AND instructor.class_schedule_id = session.class_schedule_id
              AND instructor.status = 'active') AS instructors,
          ceil((
            (SELECT count(*)::integer FROM class_enrollments e
              WHERE e.org_id = session.org_id
                AND e.class_offering_id = session.class_offering_id
                AND e.status IN ('trial', 'active')
                AND e.starts_on <= (event.starts_at AT TIME ZONE event.timezone)::date
                AND (e.ends_on IS NULL OR e.ends_on >=
                  (event.starts_at AT TIME ZONE event.timezone)::date))
            +
            (SELECT count(*)::integer FROM class_session_bookings b
              WHERE b.org_id = session.org_id
                AND b.class_session_id = session.id
                AND b.status IN ('booked', 'attended'))
          ) / offering.instructor_ratio)::integer AS required_instructors
        FROM class_sessions session
        JOIN events event ON event.org_id = session.org_id
          AND event.id = session.event_id
        JOIN class_offerings offering ON offering.org_id = session.org_id
          AND offering.id = session.class_offering_id
        WHERE session.org_id = ${this.context.orgId}::uuid
          AND session.holiday_skipped = false
          AND event.status = 'scheduled'
          AND event.starts_at BETWEEN now() AND now() + interval '14 days'
      `.execute(trx);

      return {
        enrollmentByLevel: byLevel.rows.map((row) => ({
          levelId: row.level_id,
          levelName: row.level_name,
          activeEnrollments: row.active_enrollments,
          capacity: row.capacity,
        })),
        enrollmentByClass: byClass.rows.map((row) => ({
          classOfferingId: row.id,
          name: row.name,
          levelName: row.level_name,
          activeEnrollments: row.enrolled,
          capacity: row.capacity,
          utilizationBps:
            row.capacity > 0
              ? Math.min(
                  10_000,
                  Math.round((row.enrolled / row.capacity) * 10_000),
                )
              : 0,
        })),
        utilizationHeatmap: heatmap.rows.map((row) => ({
          weekday: row.weekday,
          startHour: row.start_hour,
          enrolledCount: row.enrolled_count,
          capacity: row.capacity,
          utilizationBps:
            row.capacity > 0
              ? Math.min(
                  10_000,
                  Math.round((row.enrolled_count / row.capacity) * 10_000),
                )
              : 0,
        })),
        churn: churn.rows.map((row) => ({
          month: row.month,
          withdrawals: row.withdrawals,
          enrollments: row.enrollments,
        })),
        tuitionMrrCents: money.rows[0]?.mrr_cents ?? 0,
        activeSubscriptions: money.rows[0]?.active_subscriptions ?? 0,
        failedPayments30d: money.rows[0]?.failed_payments ?? 0,
        openMakeupCredits: makeups.count,
        ratioWarnings: ratioWarnings.rows
          .filter((row) => row.instructors < row.required_instructors)
          .map((row) => ({
            classSessionId: row.session_id,
            eventId: row.event_id,
            offeringName: row.offering_name,
            startsAt: row.starts_at.toISOString(),
            attendees: row.attendees,
            instructors: row.instructors,
            requiredInstructors: row.required_instructors,
          })),
      };
    });
  }
}
