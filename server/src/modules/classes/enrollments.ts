import { createHash } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { joiningTuition, withdrawalRefund } from '@shared/algorithms/proration';
import { newId } from '@shared/ids';
import type {
  BrowseClass,
  ClassEnrollment,
  EnrollBody,
  EnrollResult,
  TuitionTier,
  WithdrawBody,
  PauseBody,
} from '@shared/schemas/classes';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { requireVersion } from '../../lib/version-check.js';
import { appendAuditEvent } from '../audit/service.js';
import type { NewInvoiceLine } from '../finance/invoices.js';
import { createNotification } from '../notifications/service.js';

import {
  AgeIneligibleError,
  ClassesConflictError,
  ClassesNotFoundError,
  OfferingFullError,
} from './errors.js';
import {
  issueCreditInTransaction,
  issueInvoiceInTransaction,
} from './invoice-writer.js';
import { tuitionForOffering } from './tuition.js';

const WEEKDAY_NAMES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

function ageMonths(dateOfBirth: string | Date, onDate: string): number {
  const dob = Temporal.PlainDate.from(
    typeof dateOfBirth === 'string'
      ? dateOfBirth.slice(0, 10)
      : dateOfBirth.toISOString().slice(0, 10),
  );
  const on = Temporal.PlainDate.from(onDate);
  const diff = dob.until(on, { largestUnit: 'months' });
  return diff.years * 12 + diff.months;
}

export function dateOnly(value: string | Date): string {
  return typeof value === 'string'
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}

export function monthRange(containing: string): {
  start: string;
  end: string;
} {
  const date = Temporal.PlainDate.from(containing);
  const start = new Temporal.PlainDate(date.year, date.month, 1);
  const end = start.add({ months: 1 }).subtract({ days: 1 });
  return { start: start.toString(), end: end.toString() };
}

function nextMonthBillingDate(billingDay: number, after: string): string {
  const date = Temporal.PlainDate.from(after);
  const thisMonth = new Temporal.PlainDate(date.year, date.month, billingDay);
  return (
    Temporal.PlainDate.compare(thisMonth, date) > 0
      ? thisMonth
      : thisMonth.add({ months: 1 })
  ).toString();
}

/** Local dates of real (non-holiday, non-canceled) sessions of an offering. */
export async function sessionDatesInRange(
  trx: OrgTransaction,
  orgId: string,
  classOfferingId: string,
  from: string,
  to: string,
): Promise<string[]> {
  const rows = await sql<{ day: string }>`
    SELECT DISTINCT (event.starts_at AT TIME ZONE event.timezone)::date::text AS day
    FROM class_sessions session
    JOIN events event ON event.org_id = session.org_id
      AND event.id = session.event_id
    WHERE session.org_id = ${orgId}::uuid
      AND session.class_offering_id = ${classOfferingId}::uuid
      AND session.holiday_skipped = false
      AND event.status IN ('scheduled', 'postponed', 'completed')
      AND (event.starts_at AT TIME ZONE event.timezone)::date
        BETWEEN ${from}::date AND ${to}::date
    ORDER BY day
  `.execute(trx);
  return rows.rows.map((row) => row.day);
}

interface OfferingBillingRow {
  id: string;
  name: string;
  billing: string;
  price_cents: number;
  tuition_tiers: unknown;
  annual_fee_cents: number;
  annual_fee_interval_months: number;
  trial_allowed: boolean;
  trial_price_cents: number;
  makeup_policy: unknown;
  sibling_discount_bps: unknown;
  capacity: number;
  age_min_months: number | null;
  age_max_months: number | null;
  skill_level_id: string | null;
  program_id: string;
  status: string;
}

interface EnrollmentRow {
  id: string;
  class_offering_id: string;
  offering_name: string;
  person_id: string;
  person_name: string;
  household_id: string;
  account_id: string;
  status: string;
  starts_on: string;
  ends_on: string | null;
  withdraw_effective_on: string | null;
  pause_from: string | null;
  pause_to: string | null;
  classes_per_week: number;
  billing_subscription_id: string | null;
  version: number;
  created_at: Date;
}

const ENROLLMENT_SELECT = `
  SELECT enrollment.id, enrollment.class_offering_id,
    offering.name AS offering_name,
    enrollment.person_id,
    person.first_name || ' ' || person.last_name AS person_name,
    enrollment.household_id, enrollment.account_id,
    enrollment.status, enrollment.starts_on::text, enrollment.ends_on::text,
    enrollment.withdraw_effective_on::text, enrollment.pause_from::text,
    enrollment.pause_to::text, enrollment.classes_per_week,
    enrollment.billing_subscription_id, enrollment.version,
    enrollment.created_at
  FROM class_enrollments enrollment
  JOIN class_offerings offering ON offering.org_id = enrollment.org_id
    AND offering.id = enrollment.class_offering_id
  JOIN people person ON person.org_id = enrollment.org_id
    AND person.id = enrollment.person_id
`;

function mapEnrollment(row: EnrollmentRow): ClassEnrollment {
  return {
    id: row.id,
    classOfferingId: row.class_offering_id,
    offeringName: row.offering_name,
    personId: row.person_id,
    personName: row.person_name,
    householdId: row.household_id,
    accountId: row.account_id,
    status: row.status as ClassEnrollment['status'],
    startsOn: dateOnly(row.starts_on),
    endsOn: row.ends_on ? dateOnly(row.ends_on) : null,
    withdrawEffectiveOn: row.withdraw_effective_on
      ? dateOnly(row.withdraw_effective_on)
      : null,
    pauseFrom: row.pause_from ? dateOnly(row.pause_from) : null,
    pauseTo: row.pause_to ? dateOnly(row.pause_to) : null,
    classesPerWeek: row.classes_per_week,
    billingSubscriptionId: row.billing_subscription_id,
    version: row.version,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadOffering(
  trx: OrgTransaction,
  orgId: string,
  offeringId: string,
  lock = false,
): Promise<OfferingBillingRow> {
  const query = trx
    .selectFrom('class_offerings')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('id', '=', offeringId);
  const row = await (lock
    ? query.forUpdate().executeTakeFirst()
    : query.executeTakeFirst());
  if (!row) throw new ClassesNotFoundError('Class offering not found');
  return row;
}

async function enrolledCount(
  trx: OrgTransaction,
  orgId: string,
  offeringId: string,
): Promise<number> {
  const row = await trx
    .selectFrom('class_enrollments')
    .select(sql<number>`count(*)::integer`.as('count'))
    .where('org_id', '=', orgId)
    .where('class_offering_id', '=', offeringId)
    .where('status', 'in', ['trial', 'active', 'paused'])
    .executeTakeFirstOrThrow();
  return row.count;
}

function assertAgeEligible(
  offering: OfferingBillingRow,
  dateOfBirth: string | Date,
  startsOn: string,
): void {
  if (offering.age_min_months === null && offering.age_max_months === null)
    return;
  const months = ageMonths(dateOfBirth, startsOn);
  if (
    (offering.age_min_months !== null && months < offering.age_min_months) ||
    (offering.age_max_months !== null && months > offering.age_max_months)
  )
    throw new AgeIneligibleError();
}

async function assertLevelEligible(
  trx: OrgTransaction,
  orgId: string,
  offering: OfferingBillingRow,
  personId: string,
  staffOverride: boolean,
): Promise<void> {
  if (!offering.skill_level_id || staffOverride) return;
  const target = await trx
    .selectFrom('skill_levels')
    .select(['id', 'sport_profile_id', 'sort_order'])
    .where('org_id', '=', orgId)
    .where('id', '=', offering.skill_level_id)
    .executeTakeFirst();
  if (!target) return;
  const current = await sql<{ level_id: string }>`
    SELECT level.id AS level_id
    FROM level_promotions promotion
    JOIN skill_levels level ON level.org_id = promotion.org_id
      AND level.id = promotion.to_level_id
    WHERE promotion.org_id = ${orgId}::uuid
      AND promotion.person_id = ${personId}::uuid
      AND promotion.status = 'completed'
    ORDER BY promotion.created_at DESC
    LIMIT 1
  `.execute(trx);
  const currentLevel = current.rows[0];
  if (currentLevel && currentLevel.level_id !== target.id)
    throw new ClassesConflictError(
      'The athlete is currently placed in a different level',
      'LEVEL_MISMATCH',
    );
  if (!currentLevel) {
    const lowest = await trx
      .selectFrom('skill_levels')
      .select('id')
      .where('org_id', '=', orgId)
      .where('sport_profile_id', '=', target.sport_profile_id)
      .orderBy('sort_order')
      .limit(1)
      .executeTakeFirst();
    if (lowest && lowest.id !== target.id)
      throw new ClassesConflictError(
        'New athletes start in the entry level',
        'LEVEL_MISMATCH',
      );
  }
}

async function enqueueWaitlist(
  trx: OrgTransaction,
  context: OrgContext,
  input: { offeringId: string; personId: string; householdId: string },
): Promise<{ id: string; position: number }> {
  const existing = await trx
    .selectFrom('class_waitlist_entries')
    .select(['id', 'position'])
    .where('org_id', '=', context.orgId)
    .where('class_offering_id', '=', input.offeringId)
    .where('person_id', '=', input.personId)
    .where('status', 'in', ['waiting', 'offered'])
    .executeTakeFirst();
  if (existing) return { id: existing.id, position: existing.position };
  const positionRow = await trx
    .selectFrom('class_waitlist_entries')
    .select(sql<number>`coalesce(max(position), 0) + 1`.as('position'))
    .where('org_id', '=', context.orgId)
    .where('class_offering_id', '=', input.offeringId)
    .executeTakeFirstOrThrow();
  const id = newId();
  await trx
    .insertInto('class_waitlist_entries')
    .values({
      id,
      org_id: context.orgId,
      class_offering_id: input.offeringId,
      person_id: input.personId,
      household_id: input.householdId,
      account_id: context.actor.accountId,
      position: positionRow.position,
      status: 'waiting',
    })
    .execute();
  await appendAuditEvent(trx, context, {
    action: 'classes.waitlist_joined',
    entityType: 'class_waitlist_entry',
    entityId: id,
    changes: { position: { tier: 'internal', after: positionRow.position } },
  });
  return { id, position: positionRow.position };
}

/** Offer the next waiting entry a freed spot. */
export async function offerNextWaitlistEntry(
  trx: OrgTransaction,
  context: OrgContext,
  offeringId: string,
): Promise<boolean> {
  const offering = await loadOffering(trx, context.orgId, offeringId, true);
  const count = await enrolledCount(trx, context.orgId, offeringId);
  if (count >= offering.capacity) return false;
  const next = await trx
    .selectFrom('class_waitlist_entries')
    .select(['id', 'account_id', 'person_id'])
    .where('org_id', '=', context.orgId)
    .where('class_offering_id', '=', offeringId)
    .where('status', '=', 'waiting')
    .orderBy('position')
    .limit(1)
    .forUpdate()
    .executeTakeFirst();
  if (!next) return false;
  await trx
    .updateTable('class_waitlist_entries')
    .set({
      status: 'offered',
      offered_at: sql`now()`,
      offer_expires_at: sql`now() + interval '48 hours'`,
      version: sql`version + 1`,
    })
    .where('org_id', '=', context.orgId)
    .where('id', '=', next.id)
    .execute();
  await createNotification(trx, context, {
    accountId: next.account_id,
    type: 'registration.waitlist_offer',
    payload: {
      resourceType: 'class_offering',
      resourceId: offering.id,
      personId: next.person_id,
      href: '/classes',
    },
  });
  await appendAuditEvent(trx, context, {
    action: 'classes.waitlist_offered',
    entityType: 'class_waitlist_entry',
    entityId: next.id,
    changes: {},
  });
  return true;
}

export class PostgresClassEnrollments {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async browse(input: {
    programId?: string;
    levelId?: string;
    day?: string;
    ageMonths?: number;
    personId?: string;
    limit?: number;
  }): Promise<BrowseClass[]> {
    return this.withOrg(this.context, async (trx) => {
      let ageFilter = input.ageMonths;
      if (ageFilter === undefined && input.personId) {
        const person = await trx
          .selectFrom('people')
          .select(['date_of_birth'])
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', input.personId)
          .executeTakeFirst();
        if (person) {
          const org = await trx
            .selectFrom('organizations')
            .select('timezone')
            .where('id', '=', this.context.orgId)
            .executeTakeFirstOrThrow();
          const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: org.timezone,
          }).format(new Date());
          ageFilter = ageMonths(
            person.date_of_birth instanceof Date
              ? person.date_of_birth.toISOString().slice(0, 10)
              : String(person.date_of_birth).slice(0, 10),
            today,
          );
        }
      }
      const rows = await sql<{
        id: string;
        program_id: string;
        program_name: string;
        name: string;
        description: string | null;
        level_name: string | null;
        billing: string;
        price_cents: number;
        trial_allowed: boolean;
        trial_price_cents: number;
        age_min_months: number | null;
        age_max_months: number | null;
        capacity: number;
        enrolled_count: number;
        waitlist_count: number;
      }>`
        SELECT offering.id, offering.program_id, program.name AS program_name,
          offering.name, offering.description, level.name AS level_name,
          offering.billing, offering.price_cents, offering.trial_allowed,
          offering.trial_price_cents, offering.age_min_months,
          offering.age_max_months, offering.capacity,
          (SELECT count(*)::integer FROM class_enrollments e
            WHERE e.org_id = offering.org_id AND e.class_offering_id = offering.id
              AND e.status IN ('trial', 'active', 'paused')) AS enrolled_count,
          (SELECT count(*)::integer FROM class_waitlist_entries w
            WHERE w.org_id = offering.org_id AND w.class_offering_id = offering.id
              AND w.status IN ('waiting', 'offered')) AS waitlist_count
        FROM class_offerings offering
        JOIN programs program ON program.org_id = offering.org_id
          AND program.id = offering.program_id
        LEFT JOIN skill_levels level ON level.org_id = offering.org_id
          AND level.id = offering.skill_level_id
        WHERE offering.org_id = ${this.context.orgId}::uuid
          AND offering.status = 'active'
          AND program.status IN ('published', 'registration_open', 'in_progress')
          ${input.programId ? sql`AND offering.program_id = ${input.programId}::uuid` : sql``}
          ${input.levelId ? sql`AND offering.skill_level_id = ${input.levelId}::uuid` : sql``}
          ${
            ageFilter !== undefined
              ? sql`AND (offering.age_min_months IS NULL OR offering.age_min_months <= ${ageFilter})
              AND (offering.age_max_months IS NULL OR offering.age_max_months >= ${ageFilter})`
              : sql``
          }
        ORDER BY level.sort_order NULLS LAST, offering.name
        LIMIT ${input.limit ?? 100}
      `.execute(trx);
      const items: BrowseClass[] = [];
      for (const row of rows.rows) {
        const schedules = await trx
          .selectFrom('class_schedules')
          .select([
            'recurrence',
            'start_time',
            'duration_minutes',
            'timezone',
            'space_id',
          ])
          .where('org_id', '=', this.context.orgId)
          .where('class_offering_id', '=', row.id)
          .where('status', '=', 'active')
          .execute();
        const spaceIds = schedules.flatMap((s) =>
          s.space_id ? [s.space_id] : [],
        );
        const spaces = spaceIds.length
          ? await trx
              .selectFrom('spaces')
              .select(['id', 'name'])
              .where('org_id', '=', this.context.orgId)
              .where('id', 'in', spaceIds)
              .execute()
          : [];
        const spaceNames = new Map(spaces.map((s) => [s.id, s.name]));
        const meetingTimes: BrowseClass['meetingTimes'] = [];
        for (const schedule of schedules) {
          const recurrence = schedule.recurrence as {
            kind: string;
            byDay?: string[];
            date?: string;
          };
          const days =
            recurrence.kind === 'weekly'
              ? (recurrence.byDay ?? [])
              : recurrence.kind === 'once' && recurrence.date
                ? [
                    WEEKDAY_NAMES[
                      Temporal.PlainDate.from(recurrence.date).dayOfWeek - 1
                    ] ?? 'MO',
                  ]
                : [];
          for (const day of days) {
            meetingTimes.push({
              weekday: day,
              startTime: schedule.start_time.slice(0, 5),
              durationMinutes: schedule.duration_minutes,
              timezone: schedule.timezone,
              spaceName: schedule.space_id
                ? (spaceNames.get(schedule.space_id) ?? null)
                : null,
            });
          }
        }
        const nextSession = await sql<{ starts_at: Date }>`
          SELECT event.starts_at FROM class_sessions session
          JOIN events event ON event.org_id = session.org_id
            AND event.id = session.event_id
          WHERE session.org_id = ${this.context.orgId}::uuid
            AND session.class_offering_id = ${row.id}::uuid
            AND session.holiday_skipped = false
            AND event.status = 'scheduled'
            AND event.starts_at > now()
          ORDER BY event.starts_at
          LIMIT 1
        `.execute(trx);
        if (
          input.day &&
          !meetingTimes.some((time) => time.weekday === input.day)
        )
          continue;
        items.push({
          classOfferingId: row.id,
          programId: row.program_id,
          programName: row.program_name,
          name: row.name,
          description: row.description,
          levelName: row.level_name,
          billing: row.billing as BrowseClass['billing'],
          priceCents: row.price_cents,
          trialAllowed: row.trial_allowed,
          trialPriceCents: row.trial_price_cents,
          ageMinMonths: row.age_min_months,
          ageMaxMonths: row.age_max_months,
          capacity: row.capacity,
          enrolledCount: row.enrolled_count,
          spotsRemaining: Math.max(0, row.capacity - row.enrolled_count),
          waitlistCount: row.waitlist_count,
          meetingTimes,
          nextSessionAt: nextSession.rows[0]?.starts_at.toISOString() ?? null,
        });
      }
      return items;
    });
  }

  async list(input: {
    offeringId?: string;
    personId?: string;
    householdId?: string;
    accountId?: string;
    status?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: ClassEnrollment[]; nextCursor: string | null }> {
    return this.withOrg(this.context, async (trx) => {
      const cursor = input.cursor
        ? decodeCursor(input.cursor, 'created_at')
        : null;
      const rows = await sql<EnrollmentRow>`
        ${sql.raw(ENROLLMENT_SELECT)}
        WHERE enrollment.org_id = ${this.context.orgId}::uuid
          ${input.offeringId ? sql`AND enrollment.class_offering_id = ${input.offeringId}::uuid` : sql``}
          ${input.personId ? sql`AND enrollment.person_id = ${input.personId}::uuid` : sql``}
          ${input.householdId ? sql`AND enrollment.household_id = ${input.householdId}::uuid` : sql``}
          ${input.status ? sql`AND enrollment.status = ${input.status}` : sql``}
          ${
            input.accountId
              ? sql`AND EXISTS (
                SELECT 1 FROM person_account_links link
                WHERE link.org_id = enrollment.org_id
                  AND link.person_id = enrollment.person_id
                  AND link.account_id = ${input.accountId}::uuid
                  AND link.verified_at IS NOT NULL
                  AND link.revoked_at IS NULL
              )`
              : sql``
          }
          ${cursor ? sql`AND enrollment.created_at < ${String(cursor.value)}::timestamptz` : sql``}
        ORDER BY enrollment.created_at DESC, enrollment.id
        LIMIT ${input.limit + 1}
      `.execute(trx);
      const page = rows.rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        items: page.map(mapEnrollment),
        nextCursor:
          rows.rows.length > input.limit && last
            ? encodeCursor({
                sort: 'created_at',
                value: last.created_at.toISOString(),
                id: last.id,
              })
            : null,
      };
    });
  }

  async get(enrollmentId: string): Promise<ClassEnrollment> {
    return this.withOrg(this.context, (trx) =>
      this.getInTransaction(trx, enrollmentId),
    );
  }

  async getInTransaction(
    trx: OrgTransaction,
    enrollmentId: string,
  ): Promise<ClassEnrollment> {
    const rows = await sql<EnrollmentRow>`
      ${sql.raw(ENROLLMENT_SELECT)}
      WHERE enrollment.org_id = ${this.context.orgId}::uuid
        AND enrollment.id = ${enrollmentId}::uuid
    `.execute(trx);
    const row = rows.rows[0];
    if (!row) throw new ClassesNotFoundError('Enrollment not found');
    return mapEnrollment(row);
  }

  /**
   * Enroll a person. `staff=true` bypasses the level-placement gate; guardian
   * verification happens at the route layer for portal calls.
   */
  async enroll(
    input: EnrollBody,
    operationKey: string,
    options: { staff: boolean },
  ): Promise<EnrollResult> {
    return this.withOrg(this.context, (trx) =>
      this.enrollInTransaction(trx, input, operationKey, options),
    );
  }

  async enrollInTransaction(
    trx: OrgTransaction,
    input: EnrollBody,
    operationKey: string,
    options: { staff: boolean; skipInitialTuition?: boolean },
  ): Promise<EnrollResult> {
    const replay = await trx
      .selectFrom('class_enrollments')
      .select('id')
      .where('org_id', '=', this.context.orgId)
      .where('creation_key', '=', operationKey)
      .executeTakeFirst();
    if (replay) {
      const enrollment = await this.getInTransaction(trx, replay.id);
      const invoice = await trx
        .selectFrom('invoices')
        .select(['id', 'total_cents'])
        .where('org_id', '=', this.context.orgId)
        .where('creation_key', '=', operationKey)
        .executeTakeFirst();
      return {
        enrollment,
        waitlistEntry: null,
        invoiceId: invoice?.id ?? null,
        amountDueCents: invoice ? invoice.total_cents : null,
        subscriptionId: enrollment.billingSubscriptionId,
      };
    }
    const offering = await loadOffering(
      trx,
      this.context.orgId,
      input.classOfferingId,
      true,
    );
    if (offering.status !== 'active')
      throw new ClassesNotFoundError('Class offering not found');
    if (!['term', 'monthly'].includes(offering.billing) && !input.trial)
      throw new ClassesConflictError(
        'This class uses session bookings, not enrollment',
      );
    const person = await trx
      .selectFrom('people')
      .select(['id', 'date_of_birth'])
      .where('org_id', '=', this.context.orgId)
      .where('id', '=', input.personId)
      .executeTakeFirst();
    if (!person) throw new ClassesNotFoundError('Person not found');
    const member = await trx
      .selectFrom('household_members')
      .select('id')
      .where('org_id', '=', this.context.orgId)
      .where('household_id', '=', input.householdId)
      .where('person_id', '=', input.personId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    if (!member)
      throw new ClassesConflictError(
        'The athlete is not a member of this household',
      );
    assertAgeEligible(offering, person.date_of_birth, input.startsOn);
    await assertLevelEligible(
      trx,
      this.context.orgId,
      offering,
      input.personId,
      options.staff,
    );

    const duplicate = await trx
      .selectFrom('class_enrollments')
      .select('id')
      .where('org_id', '=', this.context.orgId)
      .where('class_offering_id', '=', input.classOfferingId)
      .where('person_id', '=', input.personId)
      .where('status', 'in', ['trial', 'active', 'paused'])
      .executeTakeFirst();
    if (duplicate)
      throw new ClassesConflictError(
        'The athlete is already enrolled in this class',
        'CLASS_ENROLLMENT_EXISTS',
      );

    if (input.trial) {
      if (!offering.trial_allowed)
        throw new ClassesConflictError('Trials are not offered for this class');
      const trialId = newId();
      let trialSessionId: string | null = null;
      if (input.trialSessionId) {
        const session = await trx
          .selectFrom('class_sessions')
          .innerJoin('events', (join) =>
            join
              .onRef('events.org_id', '=', 'class_sessions.org_id')
              .onRef('events.id', '=', 'class_sessions.event_id'),
          )
          .select(['class_sessions.id', 'class_sessions.class_offering_id'])
          .where('class_sessions.org_id', '=', this.context.orgId)
          .where('class_sessions.id', '=', input.trialSessionId)
          .where('class_sessions.class_offering_id', '=', input.classOfferingId)
          .where('events.status', '=', 'scheduled')
          .where('events.starts_at', '>', new Date())
          .executeTakeFirst();
        if (!session) throw new ClassesNotFoundError('Trial session not found');
        trialSessionId = session.id;
      }
      await trx
        .insertInto('class_enrollments')
        .values({
          id: trialId,
          org_id: this.context.orgId,
          class_offering_id: input.classOfferingId,
          person_id: input.personId,
          household_id: input.householdId,
          account_id: this.context.actor.accountId,
          status: 'trial',
          starts_on: input.startsOn,
          ends_on: input.startsOn,
          classes_per_week: 1,
          trial_session_id: trialSessionId,
          creation_key: operationKey,
        })
        .execute();
      if (trialSessionId) {
        await trx
          .insertInto('class_session_bookings')
          .values({
            id: newId(),
            org_id: this.context.orgId,
            class_session_id: trialSessionId,
            person_id: input.personId,
            household_id: input.householdId,
            account_id: this.context.actor.accountId,
            kind: 'trial',
            status: 'booked',
          })
          .execute();
      }
      let invoiceId: string | null = null;
      let amountDue: number | null = null;
      if (offering.trial_price_cents > 0) {
        const invoice = await issueInvoiceInTransaction(trx, this.context, {
          orgId: this.context.orgId,
          accountId: this.context.actor.accountId,
          householdId: input.householdId,
          source: 'tuition',
          memo: `Trial class — ${offering.name}`,
          creationKey: operationKey,
          lines: [
            {
              kind: 'tuition',
              description: `${offering.name} — trial class`,
              amountCents: offering.trial_price_cents,
              refundable: false,
            },
          ],
        });
        invoiceId = invoice.id;
        amountDue = offering.trial_price_cents;
      }
      await appendAuditEvent(trx, this.context, {
        action: 'classes.trial_enrolled',
        entityType: 'class_enrollment',
        entityId: trialId,
        changes: {},
      });
      return {
        enrollment: await this.getInTransaction(trx, trialId),
        waitlistEntry: null,
        invoiceId,
        amountDueCents: amountDue,
        subscriptionId: null,
      };
    }

    const count = await enrolledCount(
      trx,
      this.context.orgId,
      input.classOfferingId,
    );
    if (count >= offering.capacity) {
      const entry = await enqueueWaitlist(trx, this.context, {
        offeringId: input.classOfferingId,
        personId: input.personId,
        householdId: input.householdId,
      });
      return {
        enrollment: null,
        waitlistEntry: {
          id: entry.id,
          position: entry.position,
          status: 'waiting',
        },
        invoiceId: null,
        amountDueCents: null,
        subscriptionId: null,
      };
    }

    const id = newId();
    const subscriptionId =
      offering.billing === 'monthly'
        ? await this.getOrCreateSubscription(trx, input)
        : null;
    const lines: NewInvoiceLine[] = [];
    let dueOn: string | undefined;
    if (offering.billing === 'term') {
      const term = await sql<{ term_start: string; term_end: string }>`
        SELECT min(term_start)::text AS term_start, max(term_end)::text AS term_end
        FROM class_schedules
        WHERE org_id = ${this.context.orgId}::uuid
          AND class_offering_id = ${input.classOfferingId}::uuid
          AND status = 'active'
      `.execute(trx);
      const termStart = term.rows[0]?.term_start ?? input.startsOn;
      const termEnd = term.rows[0]?.term_end ?? input.startsOn;
      const allSessions = await sessionDatesInRange(
        trx,
        this.context.orgId,
        input.classOfferingId,
        termStart,
        termEnd,
      );
      const charge = joiningTuition(
        offering.price_cents,
        allSessions,
        input.startsOn,
        'session_count',
      ).chargeCents;
      if (charge > 0)
        lines.push({
          kind: 'tuition',
          description: `${offering.name} — term tuition`,
          amountCents: charge,
          refundable: true,
        });
    } else {
      const subscription = await trx
        .selectFrom('tuition_subscriptions')
        .select(['proration'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', subscriptionId ?? '')
        .executeTakeFirst();
      const month = monthRange(input.startsOn);
      const sessions = await sessionDatesInRange(
        trx,
        this.context.orgId,
        input.classOfferingId,
        month.start,
        month.end,
      );
      const monthlyDelta = await this.householdMonthlyDelta(
        trx,
        input.householdId,
        {
          offeringId: input.classOfferingId,
          classesPerWeek: input.classesPerWeek,
        },
      );
      const charge = joiningTuition(
        monthlyDelta,
        sessions,
        input.startsOn,
        (subscription?.proration ?? 'session_count') as
          'session_count' | 'full_month' | 'no_charge_after_20th',
      ).chargeCents;
      if (charge > 0)
        lines.push({
          kind: 'tuition',
          description: `${offering.name} — first month tuition (prorated)`,
          amountCents: charge,
          refundable: true,
        });
    }
    if (offering.annual_fee_cents > 0) {
      lines.push({
        kind: 'service_fee',
        description: `${offering.name} — annual registration fee`,
        amountCents: offering.annual_fee_cents,
        refundable: false,
      });
    }

    await trx
      .insertInto('class_enrollments')
      .values({
        id,
        org_id: this.context.orgId,
        class_offering_id: input.classOfferingId,
        person_id: input.personId,
        household_id: input.householdId,
        account_id: this.context.actor.accountId,
        status: 'active',
        starts_on: input.startsOn,
        classes_per_week: input.classesPerWeek,
        billing_subscription_id: subscriptionId,
        creation_key: operationKey,
        annual_fee_next_on:
          offering.annual_fee_cents > 0
            ? Temporal.PlainDate.from(input.startsOn)
                .add({ months: offering.annual_fee_interval_months })
                .toString()
            : null,
      })
      .execute();

    let invoiceId: string | null = null;
    let amountDue: number | null = null;
    const invoiceLines = options.skipInitialTuition
      ? lines.filter((line) => line.kind !== 'tuition')
      : lines;
    if (invoiceLines.length) {
      const invoice = await issueInvoiceInTransaction(trx, this.context, {
        orgId: this.context.orgId,
        accountId: this.context.actor.accountId,
        householdId: input.householdId,
        source: 'tuition',
        memo: `${offering.name} enrollment`,
        creationKey: operationKey,
        ...(dueOn ? { dueOn } : {}),
        lines: invoiceLines,
      });
      invoiceId = invoice.id;
      amountDue = invoice.totalCents;
      if (subscriptionId) {
        await this.attachAutopayInstallment(
          trx,
          subscriptionId,
          invoiceId,
          invoice.totalCents,
          input.startsOn,
          operationKey,
        );
      }
    }
    await appendAuditEvent(trx, this.context, {
      action: 'classes.enrolled',
      entityType: 'class_enrollment',
      entityId: id,
      changes: {
        offeringId: { tier: 'internal', after: input.classOfferingId },
      },
    });
    return {
      enrollment: await this.getInTransaction(trx, id),
      waitlistEntry: null,
      invoiceId,
      amountDueCents: amountDue,
      subscriptionId,
    };
  }

  /**
   * If the subscription carries an autopay mandate, bind the invoice's first
   * installment to the saved method so installments.charge can collect it.
   */
  async attachAutopayInstallment(
    trx: OrgTransaction,
    subscriptionId: string,
    invoiceId: string,
    totalCents: number,
    dueOn: string,
    operationKey: string,
  ): Promise<void> {
    const subscription = await trx
      .selectFrom('tuition_subscriptions')
      .select(['account_id', 'payment_method_id', 'mandate_text_version'])
      .where('org_id', '=', this.context.orgId)
      .where('id', '=', subscriptionId)
      .executeTakeFirst();
    if (!subscription?.payment_method_id || !subscription.mandate_text_version)
      return;
    await trx
      .insertInto('installments')
      .values({
        id: newId(),
        org_id: this.context.orgId,
        invoice_id: invoiceId,
        sequence: 1,
        due_on: dueOn,
        amount_cents: totalCents,
        autopay: true,
        payment_method_id: subscription.payment_method_id,
      })
      .execute();
    await sql`
      INSERT INTO autopay_authorizations
        (id, org_id, account_id, payment_method_id, invoice_id,
         mandate_text_version, mandate_text_hash, operation_key)
      VALUES (${newId()}::uuid, ${this.context.orgId}::uuid,
        ${subscription.account_id}::uuid,
        ${subscription.payment_method_id}::uuid, ${invoiceId}::uuid,
        ${subscription.mandate_text_version},
        ${mandateHash()}, ${operationKey}::uuid)
      ON CONFLICT DO NOTHING
    `.execute(trx);
  }

  /** Monthly amount delta for adding one enrollment (tier + sibling logic). */
  private async householdMonthlyDelta(
    trx: OrgTransaction,
    householdId: string,
    extra: { offeringId: string; classesPerWeek: number },
  ): Promise<number> {
    const withExtra = await this.householdMonthlyCents(trx, householdId, extra);
    const without = await this.householdMonthlyCents(trx, householdId, null);
    return Math.max(0, withExtra - without);
  }

  /** Household monthly tuition: per-offering tiers on family classes/week. */
  async householdMonthlyCents(
    trx: OrgTransaction,
    householdId: string,
    extra: { offeringId: string; classesPerWeek: number } | null,
  ): Promise<number> {
    const rows = await trx
      .selectFrom('class_enrollments as enrollment')
      .innerJoin('class_offerings as offering', (join) =>
        join
          .onRef('offering.org_id', '=', 'enrollment.org_id')
          .onRef('offering.id', '=', 'enrollment.class_offering_id'),
      )
      .select([
        'enrollment.class_offering_id',
        'enrollment.classes_per_week',
        'offering.price_cents',
        'offering.tuition_tiers',
        'offering.sibling_discount_bps',
      ])
      .where('enrollment.org_id', '=', this.context.orgId)
      .where('enrollment.household_id', '=', householdId)
      .where('enrollment.status', 'in', ['active', 'paused'])
      .execute();
    const byOffering = new Map<
      string,
      {
        cpw: number;
        priceCents: number;
        tiers: TuitionTier[];
        siblingBps: number[];
        perEnrollment: number[];
      }
    >();
    const tiersSchema = z.array(
      z.strictObject({
        maxClassesPerWeek: z.number().int().positive().nullable(),
        amountCents: z.number().int().nonnegative(),
      }),
    );
    const add = (
      offeringId: string,
      cpw: number,
      priceCents: number,
      tiers: unknown,
      siblingBps: unknown,
    ) => {
      const group = byOffering.get(offeringId) ?? {
        cpw: 0,
        priceCents,
        tiers: tiersSchema.parse(tiers ?? []),
        siblingBps: z.array(z.number().int()).parse(siblingBps ?? []),
        perEnrollment: [],
      };
      group.cpw += cpw;
      group.perEnrollment.push(priceCents);
      byOffering.set(offeringId, group);
    };
    for (const row of rows)
      add(
        row.class_offering_id,
        row.classes_per_week,
        row.price_cents,
        row.tuition_tiers,
        row.sibling_discount_bps,
      );
    if (extra) {
      const offering = await trx
        .selectFrom('class_offerings')
        .select(['price_cents', 'tuition_tiers', 'sibling_discount_bps'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', extra.offeringId)
        .executeTakeFirstOrThrow();
      add(
        extra.offeringId,
        extra.classesPerWeek,
        offering.price_cents,
        offering.tuition_tiers,
        offering.sibling_discount_bps,
      );
    }
    let total = 0;
    for (const group of byOffering.values()) {
      total += tuitionForOffering(
        group.cpw,
        group.perEnrollment,
        group.tiers,
        group.siblingBps,
      );
    }
    return total;
  }

  private async getOrCreateSubscription(
    trx: OrgTransaction,
    input: EnrollBody,
  ): Promise<string> {
    const existing = await trx
      .selectFrom('tuition_subscriptions')
      .select('id')
      .where('org_id', '=', this.context.orgId)
      .where('household_id', '=', input.householdId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (existing) return existing.id;
    const id = newId();
    const nextBillOn = nextMonthBillingDate(input.billingDay, input.startsOn);
    await trx
      .insertInto('tuition_subscriptions')
      .values({
        id,
        org_id: this.context.orgId,
        account_id: this.context.actor.accountId,
        household_id: input.householdId,
        status: 'active',
        billing_day: input.billingDay,
        payment_method_id: input.paymentMethodId,
        next_bill_on: nextBillOn,
        mandate_text_version: input.autopay ? 'tuition-autopay-v1' : null,
        mandate_accepted_at: input.autopay ? sql`now()` : null,
        proration: 'session_count',
      })
      .execute();
    return id;
  }

  async withdraw(
    enrollmentId: string,
    input: WithdrawBody,
    options: { staff: boolean },
    operationKey: string,
  ): Promise<{
    enrollment: ClassEnrollment;
    billThrough: string;
    refundCents: number;
  }> {
    return this.withOrg(this.context, async (trx) => {
      const enrollment = await trx
        .selectFrom('class_enrollments')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', enrollmentId)
        .forUpdate()
        .executeTakeFirst();
      if (!enrollment) throw new ClassesNotFoundError('Enrollment not found');
      requireVersion(enrollment, input.expectedVersion);
      if (!['trial', 'active', 'paused'].includes(enrollment.status))
        throw new ClassesConflictError('Enrollment is not active');

      const org = await trx
        .selectFrom('organizations')
        .select('timezone')
        .where('id', '=', this.context.orgId)
        .executeTakeFirstOrThrow();
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: org.timezone,
      }).format(new Date());

      let noticeDays = 0;
      if (enrollment.billing_subscription_id) {
        const subscription = await trx
          .selectFrom('tuition_subscriptions')
          .select(['withdrawal_notice_days'])
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', enrollment.billing_subscription_id)
          .executeTakeFirst();
        noticeDays = subscription?.withdrawal_notice_days ?? 0;
      }
      const requested = input.effectiveOn ?? today;
      const noticeEnd = Temporal.PlainDate.from(today)
        .add({ days: noticeDays })
        .toString();
      const billThrough = (
        options.staff && input.effectiveOn
          ? Temporal.PlainDate.from(requested)
          : Temporal.PlainDate.from(
              requested > noticeEnd ? requested : noticeEnd,
            )
      ).toString();

      let refundCents = 0;
      if (enrollment.billing_subscription_id) {
        const month = monthRange(today);
        const sessions = await sessionDatesInRange(
          trx,
          this.context.orgId,
          enrollment.class_offering_id,
          month.start,
          month.end,
        );
        const paid = await this.enrollmentMonthlyShare(
          trx,
          enrollment.household_id,
        );
        const refundable = withdrawalRefund(paid, sessions, billThrough);
        if (refundable > 0) {
          await issueCreditInTransaction(trx, this.context, {
            householdId: enrollment.household_id,
            amountCents: refundable,
            source: 'class_withdrawal',
            note: `Withdrawal refund for enrollment ${enrollmentId}`,
            operationKey,
          });
          refundCents = refundable;
        }
      }

      await trx
        .updateTable('class_enrollments')
        .set({
          status: 'withdrawn',
          ends_on: billThrough,
          withdraw_effective_on: billThrough,
          withdrawn_at: sql`now()`,
          withdrawal_reason: input.reason,
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', enrollmentId)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.withdrawn',
        entityType: 'class_enrollment',
        entityId: enrollmentId,
        changes: {
          billThrough: { tier: 'internal', after: billThrough },
          refundCents: { tier: 'internal', after: refundCents },
        },
      });
      await offerNextWaitlistEntry(
        trx,
        this.context,
        enrollment.class_offering_id,
      );
      return {
        enrollment: await this.getInTransaction(trx, enrollmentId),
        billThrough,
        refundCents,
      };
    });
  }

  /** Approximate this enrollment's share of the household monthly amount. */
  private async enrollmentMonthlyShare(
    trx: OrgTransaction,
    householdId: string,
  ): Promise<number> {
    const total = await this.householdMonthlyCents(trx, householdId, null);
    const count = await trx
      .selectFrom('class_enrollments')
      .select(sql<number>`count(*)::integer`.as('count'))
      .where('org_id', '=', this.context.orgId)
      .where('household_id', '=', householdId)
      .where('status', 'in', ['active', 'paused'])
      .executeTakeFirstOrThrow();
    if (count.count === 0) return 0;
    return Math.floor(total / count.count);
  }

  async pause(
    enrollmentId: string,
    input: PauseBody,
  ): Promise<ClassEnrollment> {
    return this.withOrg(this.context, async (trx) => {
      const enrollment = await trx
        .selectFrom('class_enrollments')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', enrollmentId)
        .forUpdate()
        .executeTakeFirst();
      if (!enrollment) throw new ClassesNotFoundError('Enrollment not found');
      requireVersion(enrollment, input.expectedVersion);
      if (enrollment.status !== 'active')
        throw new ClassesConflictError('Only active enrollments can pause');
      if (input.pauseFrom > input.pauseTo)
        throw new ClassesConflictError('Pause end must follow pause start');
      await trx
        .updateTable('class_enrollments')
        .set({
          status: 'paused',
          pause_from: input.pauseFrom,
          pause_to: input.pauseTo,
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', enrollmentId)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'classes.paused',
        entityType: 'class_enrollment',
        entityId: enrollmentId,
        changes: {
          from: { tier: 'internal', after: input.pauseFrom },
          to: { tier: 'internal', after: input.pauseTo },
        },
      });
      return this.getInTransaction(trx, enrollmentId);
    });
  }

  async resume(
    enrollmentId: string,
    expectedVersion: number,
  ): Promise<ClassEnrollment> {
    return this.withOrg(this.context, async (trx) => {
      const enrollment = await trx
        .selectFrom('class_enrollments')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', enrollmentId)
        .forUpdate()
        .executeTakeFirst();
      if (!enrollment) throw new ClassesNotFoundError('Enrollment not found');
      requireVersion(enrollment, expectedVersion);
      if (enrollment.status !== 'paused')
        throw new ClassesConflictError('Enrollment is not paused');
      await trx
        .updateTable('class_enrollments')
        .set({
          status: 'active',
          pause_from: null,
          pause_to: null,
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', enrollmentId)
        .execute();
      return this.getInTransaction(trx, enrollmentId);
    });
  }

  async waitlist(offeringId: string): Promise<
    {
      id: string;
      classOfferingId: string;
      personId: string;
      personName: string;
      householdId: string;
      position: number;
      status: string;
      offeredAt: string | null;
      offerExpiresAt: string | null;
      createdAt: string;
    }[]
  > {
    return this.withOrg(this.context, async (trx) => {
      const offering = await trx
        .selectFrom('class_offerings')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', offeringId)
        .executeTakeFirst();
      if (!offering) throw new ClassesNotFoundError('Class offering not found');

      const rows = await trx
        .selectFrom('class_waitlist_entries as entry')
        .innerJoin('people as person', (join) =>
          join
            .onRef('person.org_id', '=', 'entry.org_id')
            .onRef('person.id', '=', 'entry.person_id'),
        )
        .select([
          'entry.id',
          'entry.class_offering_id',
          'entry.person_id',
          'entry.household_id',
          'entry.position',
          'entry.status',
          'entry.offered_at',
          'entry.offer_expires_at',
          'entry.created_at',
          'person.first_name',
          'person.last_name',
        ])
        .where('entry.org_id', '=', this.context.orgId)
        .where('entry.class_offering_id', '=', offeringId)
        .where('entry.status', 'in', ['waiting', 'offered'])
        .orderBy('entry.position')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        classOfferingId: row.class_offering_id,
        personId: row.person_id,
        personName: `${row.first_name} ${row.last_name}`,
        householdId: row.household_id,
        position: row.position,
        status: row.status,
        offeredAt: row.offered_at?.toISOString() ?? null,
        offerExpiresAt: row.offer_expires_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  async waitlistForAccount(
    accountId: string,
    personId?: string,
  ): Promise<Awaited<ReturnType<PostgresClassEnrollments['waitlist']>>> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await trx
        .selectFrom('class_waitlist_entries as entry')
        .innerJoin('people as person', (join) =>
          join
            .onRef('person.org_id', '=', 'entry.org_id')
            .onRef('person.id', '=', 'entry.person_id'),
        )
        .select([
          'entry.id',
          'entry.class_offering_id',
          'entry.person_id',
          'entry.household_id',
          'entry.position',
          'entry.status',
          'entry.offered_at',
          'entry.offer_expires_at',
          'entry.created_at',
          'person.first_name',
          'person.last_name',
        ])
        .where('entry.org_id', '=', this.context.orgId)
        .where('entry.account_id', '=', accountId)
        .where('entry.status', 'in', ['waiting', 'offered'])
        .$if(Boolean(personId), (query) =>
          query.where('entry.person_id', '=', personId ?? ''),
        )
        .orderBy('entry.created_at', 'desc')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        classOfferingId: row.class_offering_id,
        personId: row.person_id,
        personName: `${row.first_name} ${row.last_name}`,
        householdId: row.household_id,
        position: row.position,
        status: row.status,
        offeredAt: row.offered_at?.toISOString() ?? null,
        offerExpiresAt: row.offer_expires_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  async acceptWaitlistOffer(
    entryId: string,
    body: EnrollBody,
    operationKey: string,
    options: { staff: boolean },
  ): Promise<EnrollResult> {
    return this.withOrg(this.context, async (trx) => {
      const entry = await trx
        .selectFrom('class_waitlist_entries')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', entryId)
        .forUpdate()
        .executeTakeFirst();
      if (!entry) throw new ClassesNotFoundError('Waitlist offer not found');
      if (!options.staff && entry.account_id !== this.context.actor.accountId)
        throw new ClassesNotFoundError('Waitlist offer not found');
      if (entry.status !== 'offered')
        throw new ClassesConflictError('No open offer exists');
      if (entry.offer_expires_at && entry.offer_expires_at < new Date())
        throw new ClassesConflictError('The offer expired');
      const offering = await loadOffering(
        trx,
        this.context.orgId,
        entry.class_offering_id,
        true,
      );
      const count = await enrolledCount(
        trx,
        this.context.orgId,
        entry.class_offering_id,
      );
      if (count >= offering.capacity) throw new OfferingFullError();
      const result = await this.enrollInTransaction(
        trx,
        {
          ...body,
          classOfferingId: entry.class_offering_id,
          personId: entry.person_id,
          householdId: entry.household_id,
        },
        operationKey,
        options,
      );
      if (result.enrollment) {
        await trx
          .updateTable('class_waitlist_entries')
          .set({
            status: 'accepted',
            enrollment_id: result.enrollment.id,
            version: sql`version + 1`,
          })
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', entryId)
          .execute();
      }
      return result;
    });
  }

  async declineWaitlistOffer(
    entryId: string,
    accountId?: string,
  ): Promise<void> {
    return this.withOrg(this.context, async (trx) => {
      const entry = await trx
        .selectFrom('class_waitlist_entries')
        .select(['id', 'status', 'class_offering_id'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', entryId)
        .$if(Boolean(accountId), (query) =>
          query.where('account_id', '=', accountId ?? ''),
        )
        .forUpdate()
        .executeTakeFirst();
      if (!entry || entry.status !== 'offered')
        throw new ClassesNotFoundError('No open offer exists');
      await trx
        .updateTable('class_waitlist_entries')
        .set({ status: 'declined', version: sql`version + 1` })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', entryId)
        .execute();
      await offerNextWaitlistEntry(trx, this.context, entry.class_offering_id);
    });
  }

  async removeFromWaitlist(entryId: string): Promise<void> {
    return this.withOrg(this.context, async (trx) => {
      const updated = await trx
        .updateTable('class_waitlist_entries')
        .set({ status: 'removed', version: sql`version + 1` })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', entryId)
        .where('status', 'in', ['waiting', 'offered'])
        .returning('id')
        .execute();
      if (!updated.length)
        throw new ClassesNotFoundError('Waitlist entry not found');
    });
  }
}

export const TUITION_AUTOPAY_TEXT =
  'I authorize this organization to charge my saved payment method for monthly tuition invoices for this subscription. I may stop future automatic charges at any time by updating the subscription.';

function mandateHash(): string {
  return createHash('sha256').update(TUITION_AUTOPAY_TEXT).digest('hex');
}
