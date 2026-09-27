import { createHash, randomUUID } from 'node:crypto';

import { orgToday } from '@shared/dates';
import { joiningTuition, withdrawalRefund, type ProrationSetting } from '@shared/algorithms/proration';
import { expand } from '@shared/recurrence';
import type { TimedRecurrence } from '@shared/recurrence';
import { percentOf } from '@shared/money';
import { Temporal } from '@js-temporal/polyfill';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { PostgresInvoiceRepository } from '../finance/invoice-repo';
import type { NewInvoiceLine } from '../finance/invoices';
import { appendAuditEvent } from '../audit/service';

import type { ClassOfferingInput, ClassScheduleInput } from './schemas';

export type ClassDependencies = { database: Kysely<DB>; clock: () => Date };

export class ClassError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function creationUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function monthStart(date: string): string { return `${date.slice(0, 7)}-01`; }
function monthEnd(date: string): string {
  return Temporal.PlainDate.from(`${date.slice(0, 7)}-01`).add({ months: 1 }).subtract({ days: 1 }).toString();
}
function dateOnly(value: Date | string): string { return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10); }

export async function createClassOffering(dependencies: ClassDependencies, context: OrgContext, programId: string, input: ClassOfferingInput) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const program = await sql<{ id: string; mode: string }>`SELECT id,mode FROM programs WHERE org_id=${context.orgId} AND id=${programId}`.execute(trx);
    if (!program.rows[0] || program.rows[0].mode !== 'class') throw new ClassError(404, 'NOT_FOUND', 'Class program not found');
    const id = randomUUID();
    await sql`INSERT INTO class_offerings(id,org_id,program_id,name,level,minimum_age_months,maximum_age_months,capacity,instructor_ratio,billing_term,tuition_tiers,trial_allowed,makeup_credits_per_term,makeup_expires_after_days,makeup_eligible,proration_setting,recurrence,active)
      VALUES (${id},${context.orgId},${programId},${input.name},${input.level},${input.minimumAgeMonths},${input.maximumAgeMonths},${input.capacity},${input.instructorRatio},${input.billingTerm},${JSON.stringify(input.tuitionTiers)}::jsonb,${input.trialAllowed},${input.makeupCreditsPerTerm},${input.makeupExpiresAfterDays},${input.makeupEligible},${input.prorationSetting},${input.recurrence ? JSON.stringify(input.recurrence) : null}::jsonb,${input.active})`.execute(trx);
    await appendAuditEvent(trx, context, { action: 'classes.offering.created', entityType: 'class_offering', entityId: id, changes: { name: { tier: 'internal', after: input.name }, level: { tier: 'internal', after: input.level } } });
    return { id, programId, ...input };
  });
}

export async function listClassOfferings(dependencies: ClassDependencies, context: OrgContext, filters: { ageMonths?: number; level?: string; day?: string; includeInactive?: boolean } = {}) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<Record<string, unknown>>`SELECT o.id,o.program_id AS "programId",o.name,o.level,o.minimum_age_months AS "minimumAgeMonths",
      o.maximum_age_months AS "maximumAgeMonths",o.capacity,o.instructor_ratio AS "instructorRatio",o.billing_term AS "billingTerm",
      o.tuition_tiers AS "tuitionTiers",o.trial_allowed AS "trialAllowed",o.makeup_credits_per_term AS "makeupCreditsPerTerm",
      o.makeup_expires_after_days AS "makeupExpiresAfterDays",o.makeup_eligible AS "makeupEligible",o.recurrence,o.active,o.version,
      p.name AS "programName",p.starts_on AS "startsOn",p.ends_on AS "endsOn",
      (SELECT count(*)::int FROM class_enrollments e WHERE e.org_id=o.org_id AND e.class_offering_id=o.id AND e.status IN ('enrolled','trial','withdrawal_pending')) AS "enrolledCount",
      (SELECT count(*)::int FROM class_enrollments e WHERE e.org_id=o.org_id AND e.class_offering_id=o.id AND e.status='waitlisted') AS "waitlistCount"
      FROM class_offerings o JOIN programs p ON p.org_id=o.org_id AND p.id=o.program_id
      WHERE o.org_id=${context.orgId} AND (${filters.includeInactive ?? false} OR o.active=true)
        AND (${filters.ageMonths ?? null}::int IS NULL OR (${filters.ageMonths ?? null}::int BETWEEN o.minimum_age_months AND o.maximum_age_months))
        AND (${filters.level ?? null}::text IS NULL OR o.level=${filters.level ?? null})
        AND (${filters.day ?? null}::text IS NULL OR o.recurrence->'byDay' ? ${filters.day ?? ''})
        AND p.status IN ('published','registration_open','in_progress') ORDER BY o.level,o.name`.execute(trx);
    return rows.rows;
  });
}

export async function generateClassSchedule(dependencies: ClassDependencies, context: OrgContext, offeringId: string, input: ClassScheduleInput) {
  if (input.endsOn < input.startsOn) throw new ClassError(422, 'INVALID_TERM', 'Term end must not precede its start');
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const offering = await sql<{ id: string; program_id: string; name: string; active: boolean }>`SELECT id,program_id,name,active FROM class_offerings WHERE org_id=${context.orgId} AND id=${offeringId}`.execute(trx);
    if (!offering.rows[0] || !offering.rows[0].active) throw new ClassError(404, 'NOT_FOUND', 'Active class offering not found');
    if (input.facilityId) {
      const facility = await sql<{ id: string }>`SELECT id FROM facilities WHERE org_id=${context.orgId} AND id=${input.facilityId} AND status='active'`.execute(trx);
      if (!facility.rows[0]) throw new ClassError(404, 'NOT_FOUND', 'Facility not found');
    }
    const occurrences = expand({ recurrence: input.recurrence, startTime: input.startTime, durationMinutes: input.durationMinutes, timezone: input.timezone } as TimedRecurrence, input.startsOn, input.endsOn);
    const created: { id: string; eventId: string; localDate: string; startsAt: string; endsAt: string }[] = [];
    for (const occurrence of occurrences) {
      const existing = await sql<{ id: string; event_id: string | null }>`SELECT id,event_id FROM class_sessions WHERE org_id=${context.orgId} AND class_offering_id=${offeringId} AND starts_at=${occurrence.startsAt}`.execute(trx);
      if (existing.rows[0]) {
        created.push({ id: existing.rows[0].id, eventId: existing.rows[0].event_id ?? '', localDate: occurrence.localDate, startsAt: occurrence.startsAt, endsAt: occurrence.endsAt });
        continue;
      }
      const eventId = randomUUID();
      const sessionId = randomUUID();
      await sql`INSERT INTO events(id,org_id,program_id,kind,title,starts_at,ends_at,timezone,status,published)
        VALUES (${eventId},${context.orgId},${offering.rows[0].program_id},'class_session',${offering.rows[0].name},${occurrence.startsAt},${occurrence.endsAt},${input.timezone},'scheduled',false)`.execute(trx);
      await sql`INSERT INTO class_sessions(id,org_id,class_offering_id,event_id,local_date,starts_at,ends_at,timezone,facility_id)
        VALUES (${sessionId},${context.orgId},${offeringId},${eventId},${occurrence.localDate},${occurrence.startsAt},${occurrence.endsAt},${input.timezone},${input.facilityId})`.execute(trx);
      created.push({ id: sessionId, eventId, localDate: occurrence.localDate, startsAt: occurrence.startsAt, endsAt: occurrence.endsAt });
    }
    await sql`UPDATE class_offerings SET recurrence=${JSON.stringify(input.recurrence)}::jsonb,version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${offeringId}`.execute(trx);
    await appendAuditEvent(trx, context, { action: 'classes.schedule.generated', entityType: 'class_offering', entityId: offeringId, changes: { sessionCount: { tier: 'internal', after: created.length } } });
    return created;
  });
}

type TuitionTier = { key: string; name: string; classesPerWeek: number; amountCents: number; siblingDiscountBps?: number };
type EnrollmentInvoice = { id: string; householdId: string; personId: string; accountId: string; tier: TuitionTier; trial: boolean; monthly: boolean; proration: ProrationSetting; localDate: string; sessions: string[]; existingSiblingCount: number };

async function createEnrollmentInvoice(dependencies: ClassDependencies, context: OrgContext, invoice: EnrollmentInvoice) {
  if (invoice.trial || invoice.tier.amountCents === 0) return null;
  const charge = invoice.monthly
    ? joiningTuition(invoice.tier.amountCents, invoice.sessions, invoice.localDate, invoice.proration).chargeCents
    : invoice.tier.amountCents;
  const discount = invoice.existingSiblingCount > 0 ? percentOf(charge, invoice.tier.siblingDiscountBps ?? 0) : 0;
  if (charge <= 0) return null;
  const lines: NewInvoiceLine[] = [{ kind: 'tuition', description: `${invoice.tier.name} tuition`, amountCents: charge, refundable: true }];
  if (discount > 0) lines.push({ kind: 'discount' as const, description: 'Sibling tuition discount', amountCents: -discount, refundable: true, parentLineIndex: 0 });
  const issued = await new PostgresInvoiceRepository(dependencies.database, context).issue({
    orgId: context.orgId, accountId: invoice.accountId, householdId: invoice.householdId, source: 'tuition',
    dueOn: invoice.localDate, memo: `${invoice.tier.name} class tuition`, creationKey: creationUuid(`class-enrollment:${invoice.id}:initial`), lines,
  });
  if (invoice.monthly) {
    const withOrg = createWithOrg(dependencies.database);
    await withOrg(context, async (trx) => {
      await sql`UPDATE class_tuition_subscriptions SET last_invoice_id=${issued.id},version=version+1,updated_at=now()
        WHERE org_id=${context.orgId} AND class_enrollment_id=${invoice.id}`.execute(trx);
    });
  }
  return issued;
}

export async function enrollClass(dependencies: ClassDependencies, context: OrgContext, offeringId: string, input: { personId: string; householdId: string; tuitionTierKey: string; trial: boolean }) {
  const withOrg = createWithOrg(dependencies.database);
  const prepared = await withOrg(context, async (trx) => {
    const access = await sql<{ id: string; date_of_birth: Date | string; timezone: string; household_member: string; relationship: string; currency: string }>`SELECT pe.id,pe.date_of_birth,o.timezone,hm.household_id AS household_member,pal.relationship,o.currency
      FROM people pe JOIN organizations o ON o.id=pe.org_id
      JOIN person_account_links pal ON pal.org_id=pe.org_id AND pal.person_id=pe.id AND pal.account_id=${context.actor.accountId} AND pal.revoked_at IS NULL
      JOIN household_members hm ON hm.org_id=pe.org_id AND hm.person_id=pe.id AND hm.household_id=${input.householdId}
      WHERE pe.org_id=${context.orgId} AND pe.id=${input.personId} AND pe.status='active'
        AND (pal.relationship='guardian' OR (pal.relationship='self' AND pe.date_of_birth<=CURRENT_DATE-INTERVAL '18 years'))`.execute(trx);
    if (!access.rows[0]) throw new ClassError(404, 'NOT_FOUND', 'Eligible household member not found');
    const offering = await sql<{ id: string; program_id: string; level: string; min_age: number; max_age: number; capacity: number; billing_term: string; tuition_tiers: TuitionTier[]; trial_allowed: boolean; makeup: number; makeup_expiry: number; proration: ProrationSetting }>`SELECT id,program_id,level,minimum_age_months AS min_age,maximum_age_months AS max_age,capacity,billing_term,tuition_tiers,trial_allowed,makeup_credits_per_term AS makeup,makeup_expires_after_days AS makeup_expiry,proration_setting AS proration
      FROM class_offerings WHERE org_id=${context.orgId} AND id=${offeringId} AND active=true FOR UPDATE`.execute(trx);
    const row = offering.rows[0];
    if (!row) throw new ClassError(404, 'NOT_FOUND', 'Class offering not found');
    const localDate = orgToday(access.rows[0].timezone, Temporal.Instant.fromEpochMilliseconds(dependencies.clock().getTime()));
    const ageMonths = Math.floor(Temporal.PlainDate.from(dateOnly(access.rows[0].date_of_birth)).until(Temporal.PlainDate.from(localDate), { largestUnit: 'months' }).months);
    if (ageMonths < row.min_age || ageMonths > row.max_age) throw new ClassError(409, 'AGE_INELIGIBLE', 'Athlete is outside this class age range');
    if (input.trial && !row.trial_allowed) throw new ClassError(409, 'TRIAL_UNAVAILABLE', 'This class does not offer a trial');
    const tier = row.tuition_tiers.find((item) => item.key === input.tuitionTierKey);
    if (!tier) throw new ClassError(422, 'INVALID_TUITION_TIER', 'Select a valid tuition tier');
    const occupied = await sql<{ count: number }>`SELECT count(*)::int AS count FROM class_enrollments
      WHERE org_id=${context.orgId} AND class_offering_id=${offeringId} AND status IN ('enrolled','trial','withdrawal_pending')`.execute(trx);
    const status = (occupied.rows[0]?.count ?? 0) >= row.capacity ? 'waitlisted' : input.trial ? 'trial' : 'enrolled';
    const id = randomUUID();
    await sql`INSERT INTO class_enrollments(id,org_id,class_offering_id,person_id,household_id,status,billing_tier)
      VALUES (${id},${context.orgId},${offeringId},${input.personId},${input.householdId},${status},${tier.key})`.execute(trx);
    const guardians = await sql<{ account_id: string }>`SELECT pal.account_id FROM household_members hm
      JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id AND pal.revoked_at IS NULL
      WHERE hm.org_id=${context.orgId} AND hm.household_id=${input.householdId} AND hm.financially_responsible=true AND pal.relationship IN ('guardian','self')
      ORDER BY hm.is_primary_contact DESC,pal.account_id LIMIT 1`.execute(trx);
    const accountId = guardians.rows[0]?.account_id ?? context.actor.accountId;
    const siblingRows = await sql<{ count: number }>`SELECT count(*)::int AS count FROM class_enrollments
      WHERE org_id=${context.orgId} AND household_id=${input.householdId} AND status IN ('enrolled','trial','withdrawal_pending') AND id<>${id}`.execute(trx);
    const subscriptionId = row.billing_term === 'monthly' && status === 'enrolled' ? randomUUID() : null;
    const billingDay = Math.min(28, Number(localDate.slice(-2)));
    const nextBilling = Temporal.PlainDate.from(localDate).add({ months: 1 }).toString();
    if (subscriptionId) await sql`INSERT INTO class_tuition_subscriptions(id,org_id,class_enrollment_id,billing_day,amount_cents,currency,next_invoice_on)
      VALUES (${subscriptionId},${context.orgId},${id},${billingDay},${tier.amountCents},${access.rows[0].currency},${nextBilling})`.execute(trx);
    const sessions = await sql<{ local_date: Date | string }>`SELECT local_date FROM class_sessions WHERE org_id=${context.orgId} AND class_offering_id=${offeringId}
      AND local_date BETWEEN ${monthStart(localDate)} AND ${monthEnd(localDate)} AND status='scheduled' ORDER BY local_date`.execute(trx);
    await appendAuditEvent(trx, context, { action: `classes.enrollment.${status}`, entityType: 'class_enrollment', entityId: id, changes: { status: { tier: 'internal', after: status } } });
    return {
      response: { id, offeringId, personId: input.personId, status, position: status === 'waitlisted' ? (occupied.rows[0]?.count ?? 0) + 1 : null },
      invoice: status === 'enrolled' ? { id, householdId: input.householdId, personId: input.personId, accountId, tier, trial: input.trial, monthly: row.billing_term === 'monthly', proration: row.proration, localDate, sessions: sessions.rows.map((item) => typeof item.local_date === 'string' ? item.local_date : item.local_date.toISOString().slice(0, 10)), existingSiblingCount: siblingRows.rows[0]?.count ?? 0 } satisfies EnrollmentInvoice : null,
    };
  });
  if (prepared.invoice) {
    const invoice = await createEnrollmentInvoice(dependencies, context, prepared.invoice);
    return { ...prepared.response, invoiceId: invoice?.id ?? null };
  }
  return prepared.response;
}

export async function listClassSessions(dependencies: ClassDependencies, context: OrgContext, offeringId: string, from?: string, to?: string) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<Record<string, unknown>>`SELECT s.id,s.event_id AS "eventId",s.class_offering_id AS "offeringId",s.local_date AS "localDate",
      s.starts_at AS "startsAt",s.ends_at AS "endsAt",s.timezone,s.status,s.version,o.capacity,o.instructor_ratio AS "instructorRatio",
      (SELECT count(*)::int FROM class_attendance a WHERE a.org_id=s.org_id AND a.class_session_id=s.id AND a.status IN ('present','late')) AS "attendingCount",
      (SELECT count(*)::int FROM class_instructors i WHERE i.org_id=s.org_id AND i.class_offering_id=s.class_offering_id AND i.status='active'
        AND i.starts_on<=s.local_date AND (i.ends_on IS NULL OR i.ends_on>=s.local_date)) AS "instructorCount"
      FROM class_sessions s JOIN class_offerings o ON o.org_id=s.org_id AND o.id=s.class_offering_id
      WHERE s.org_id=${context.orgId} AND s.class_offering_id=${offeringId}
        AND (${from ?? null}::date IS NULL OR s.local_date>=${from ?? null}::date)
        AND (${to ?? null}::date IS NULL OR s.local_date<=${to ?? null}::date) ORDER BY s.starts_at`.execute(trx);
    return rows.rows;
  });
}

export async function listClassEnrollments(dependencies: ClassDependencies, context: OrgContext, offeringId: string) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<Record<string, unknown>>`SELECT e.id,e.class_offering_id AS "offeringId",e.person_id AS "personId",e.household_id AS "householdId",
      e.status,e.billing_tier AS "billingTier",e.enrolled_on AS "enrolledOn",e.withdrawal_notice_on AS "withdrawalNoticeOn",e.version,
      p.first_name AS "firstName",p.last_name AS "lastName",
      (SELECT count(*)::int FROM class_makeup_credits c WHERE c.org_id=e.org_id AND c.class_enrollment_id=e.id AND c.status='available') AS "makeupCredits"
      FROM class_enrollments e JOIN people p ON p.org_id=e.org_id AND p.id=e.person_id
      WHERE e.org_id=${context.orgId} AND e.class_offering_id=${offeringId} AND e.status NOT IN ('withdrawn','completed')
      ORDER BY e.status,e.created_at,e.id`.execute(trx);
    return rows.rows;
  });
}

export async function listFamilyMakeupCredits(dependencies: ClassDependencies, context: OrgContext) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<Record<string, unknown>>`SELECT c.id,c.expires_on AS "expiresOn",c.status,e.id AS "enrollmentId",e.person_id AS "personId",
      p.first_name AS "firstName",p.last_name AS "lastName",o.name AS "className",c.version
      FROM class_makeup_credits c JOIN class_enrollments e ON e.org_id=c.org_id AND e.id=c.class_enrollment_id
      JOIN class_offerings o ON o.org_id=e.org_id AND o.id=e.class_offering_id JOIN people p ON p.org_id=e.org_id AND p.id=e.person_id
      WHERE c.org_id=${context.orgId} AND e.household_id IN (
        SELECT hm.household_id FROM household_members hm JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
        WHERE hm.org_id=${context.orgId} AND pal.account_id=${context.actor.accountId} AND pal.relationship IN ('guardian','self') AND pal.revoked_at IS NULL)
      ORDER BY c.expires_on,c.id`.execute(trx);
    return rows.rows;
  });
}

export async function listFamilySkillReport(dependencies: ClassDependencies, context: OrgContext, enrollmentId: string) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const access = await sql<{ id: string }>`SELECT e.id FROM class_enrollments e JOIN household_members hm ON hm.org_id=e.org_id AND hm.household_id=e.household_id
      JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
      WHERE e.org_id=${context.orgId} AND e.id=${enrollmentId} AND pal.account_id=${context.actor.accountId}
        AND pal.relationship IN ('guardian','self') AND pal.revoked_at IS NULL`.execute(trx);
    if (!access.rows[0]) throw new ClassError(404, 'NOT_FOUND', 'Class report not found');
    const rows = await sql<Record<string, unknown>>`SELECT d.skill_key AS "skillKey",d.name,d.level AS "classLevel",r.proficiency,r.evaluated_at AS "evaluatedAt",r.notes
      FROM class_skill_records r JOIN class_skill_definitions d ON d.org_id=r.org_id AND d.id=r.skill_definition_id
      WHERE r.org_id=${context.orgId} AND r.class_enrollment_id=${enrollmentId} ORDER BY d.sort_order,d.name`.execute(trx);
    const recommendations = await sql<Record<string, unknown>>`SELECT id,from_level AS "fromLevel",recommended_level AS "recommendedLevel",status,version,created_at AS "createdAt"
      FROM class_level_recommendations WHERE org_id=${context.orgId} AND class_enrollment_id=${enrollmentId}
      AND status IN ('pending_guardian','confirmed') ORDER BY created_at DESC`.execute(trx);
    return { skills: rows.rows, recommendations: recommendations.rows };
  });
}

export async function getClassDashboard(dependencies: ClassDependencies, context: OrgContext) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const rows = await sql<Record<string, unknown>>`SELECT o.id,o.name,o.level,o.capacity,o.instructor_ratio AS "instructorRatio",
      count(DISTINCT e.id) FILTER (WHERE e.status IN ('enrolled','trial','withdrawal_pending'))::int AS "enrolledCount",
      count(DISTINCT i.id) FILTER (WHERE i.status='active')::int AS "instructorCount",
      count(DISTINCT e.id) FILTER (WHERE e.status='waitlisted')::int AS "waitlistCount",
      COALESCE(sum(s.amount_cents) FILTER (WHERE s.status IN ('active','past_due')),0)::bigint AS "monthlyRecurringCents"
      FROM class_offerings o LEFT JOIN class_enrollments e ON e.org_id=o.org_id AND e.class_offering_id=o.id
      LEFT JOIN class_instructors i ON i.org_id=o.org_id AND i.class_offering_id=o.id
      LEFT JOIN class_tuition_subscriptions s ON s.org_id=e.org_id AND s.class_enrollment_id=e.id
      WHERE o.org_id=${context.orgId} AND o.active=true GROUP BY o.id ORDER BY o.level,o.name`.execute(trx);
    return rows.rows.map((row) => ({ ...row, ratioWarning: Number(row.instructorCount) === 0 ? Number(row.enrolledCount) > 0 : Number(row.enrolledCount) / Number(row.instructorCount) > Number(row.instructorRatio) }));
  });
}

export async function assignClassInstructor(dependencies: ClassDependencies, context: OrgContext, offeringId: string, personId: string, role: 'lead' | 'instructor' | 'substitute', startsOn: string, endsOn?: string | null) {
  const withOrg = createWithOrg(dependencies.database);
  const offering = await withOrg(context, async (trx) => sql<{ program_id: string }>`SELECT program_id FROM class_offerings WHERE org_id=${context.orgId} AND id=${offeringId}`.execute(trx).then((result) => result.rows[0]));
  if (!offering) throw new ClassError(404, 'NOT_FOUND', 'Class offering not found');
  const policy = await import('../compliance/policy');
  let eligible = true;
  try { await policy.assertEligibleForRole(dependencies.database, context, { personId, role: role === 'lead' ? 'head_coach' : 'assistant_coach', programId: offering.program_id, onDate: startsOn }, dependencies.clock()); }
  catch (error) { if (error instanceof policy.RoleEligibilityError) eligible = false; else throw error; }
  return withOrg(context, async (trx) => {
    const id = randomUUID();
    await sql`INSERT INTO class_instructors(id,org_id,class_offering_id,person_id,role,starts_on,ends_on,status)
      VALUES (${id},${context.orgId},${offeringId},${personId},${role},${startsOn},${endsOn ?? null},${eligible ? 'active' : 'pending_compliance'})`.execute(trx);
    await appendAuditEvent(trx, context, { action: 'classes.instructor.assigned', entityType: 'class_instructor', entityId: id, changes: { status: { tier: 'internal', after: eligible ? 'active' : 'pending_compliance' } } });
    return { id, offeringId, personId, role, status: eligible ? 'active' : 'pending_compliance' };
  });
}

export async function recordClassAttendance(dependencies: ClassDependencies, context: OrgContext, sessionId: string, input: { enrollmentId: string; status: 'present' | 'absent' | 'late' | 'excused'; checkedInAt: string | null; checkedOutAt: string | null; pickupAccountId: string | null }) {
  if (input.checkedOutAt && !input.checkedInAt) throw new ClassError(422, 'CHECK_IN_REQUIRED', 'Check-in time is required before check-out');
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const session = await sql<{ id: string; offering_id: string; makeup_credits: number; expiry_days: number; makeup_eligible: boolean; program_start: Date; program_end: Date }>`SELECT s.id,s.class_offering_id AS offering_id,o.makeup_credits_per_term AS makeup_credits,o.makeup_expires_after_days AS expiry_days,o.makeup_eligible,p.starts_on AS program_start,p.ends_on AS program_end
      FROM class_sessions s JOIN class_offerings o ON o.org_id=s.org_id AND o.id=s.class_offering_id JOIN programs p ON p.org_id=o.org_id AND p.id=o.program_id
      WHERE s.org_id=${context.orgId} AND s.id=${sessionId} AND s.status='scheduled'`.execute(trx);
    if (!session.rows[0]) throw new ClassError(404, 'NOT_FOUND', 'Class session not found');
    const enrollment = await sql<{ id: string; person_id: string; household_id: string; status: string }>`SELECT id,person_id,household_id,status FROM class_enrollments
      WHERE org_id=${context.orgId} AND id=${input.enrollmentId} AND class_offering_id=${session.rows[0].offering_id}`.execute(trx);
    const row = enrollment.rows[0];
    if (!row || !['enrolled','trial','withdrawal_pending'].includes(row.status)) throw new ClassError(404, 'NOT_FOUND', 'Class enrollment not found');
    if (input.pickupAccountId) {
      const pickup = await sql<{ id: string }>`SELECT hm.id FROM household_members hm JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
        WHERE hm.org_id=${context.orgId} AND hm.household_id=${row.household_id} AND hm.can_pick_up=true AND pal.account_id=${input.pickupAccountId}
          AND pal.relationship='guardian' AND pal.revoked_at IS NULL`.execute(trx);
      if (!pickup.rows[0]) throw new ClassError(404, 'NOT_FOUND', 'Authorized pickup guardian not found');
    }
    const id = randomUUID();
    const attendance = await sql<{ id: string }>`INSERT INTO class_attendance(id,org_id,class_session_id,class_enrollment_id,status,checked_in_at,checked_out_at,pickup_account_id,recorded_by)
      VALUES (${id},${context.orgId},${sessionId},${input.enrollmentId},${input.status},${input.checkedInAt},${input.checkedOutAt},${input.pickupAccountId},${context.actor.accountId})
      ON CONFLICT (org_id,class_session_id,class_enrollment_id) DO UPDATE SET status=EXCLUDED.status,checked_in_at=EXCLUDED.checked_in_at,checked_out_at=EXCLUDED.checked_out_at,pickup_account_id=EXCLUDED.pickup_account_id,recorded_by=EXCLUDED.recorded_by,version=class_attendance.version+1,updated_at=now()
      RETURNING id`.execute(trx);
    const attendanceId = attendance.rows[0]?.id;
    if (!attendanceId) throw new ClassError(409, 'ATTENDANCE_CONFLICT', 'Attendance could not be saved');
    let creditId: string | null = null;
    if (input.status === 'absent' && session.rows[0].makeup_eligible && session.rows[0].makeup_credits > 0) {
      const issued = await sql<{ count: number }>`SELECT count(*)::int AS count FROM class_makeup_credits c JOIN class_attendance a ON a.org_id=c.org_id AND a.id=c.source_attendance_id
        JOIN class_sessions s ON s.org_id=a.org_id AND s.id=a.class_session_id
        WHERE c.org_id=${context.orgId} AND c.class_enrollment_id=${input.enrollmentId} AND s.local_date BETWEEN ${session.rows[0].program_start}::date AND ${session.rows[0].program_end}::date`.execute(trx);
      if ((issued.rows[0]?.count ?? 0) < session.rows[0].makeup_credits) {
        const expires = Temporal.PlainDate.from(dependencies.clock().toISOString().slice(0, 10)).add({ days: session.rows[0].expiry_days }).toString();
        creditId = randomUUID();
        await sql`INSERT INTO class_makeup_credits(id,org_id,class_enrollment_id,source_attendance_id,expires_on)
          VALUES (${creditId},${context.orgId},${input.enrollmentId},${attendanceId},${expires}) ON CONFLICT DO NOTHING`.execute(trx);
      }
    }
    await appendAuditEvent(trx, context, { action: 'classes.attendance.recorded', entityType: 'class_attendance', entityId: attendanceId, changes: { status: { tier: 'internal', after: input.status } } });
    return { id: attendanceId, sessionId, enrollmentId: input.enrollmentId, status: input.status, makeupCreditId: creditId };
  });
}

export async function bookClassMakeup(dependencies: ClassDependencies, context: OrgContext, input: { creditId: string; sessionId: string }) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const credit = await sql<{ id: string; enrollment_id: string; expires_on: Date; status: string; household_id: string; offering_id: string; target_offering_id: string; active_enrollment_count: number; capacity: number }>`SELECT c.id,c.class_enrollment_id AS enrollment_id,c.expires_on,c.status,e.household_id,e.class_offering_id AS offering_id,
      s.class_offering_id AS target_offering_id,o.capacity,(SELECT count(*)::int FROM class_enrollments active WHERE active.org_id=e.org_id AND active.class_offering_id=s.class_offering_id AND active.status IN ('enrolled','trial','withdrawal_pending')) AS active_enrollment_count
      FROM class_makeup_credits c JOIN class_enrollments e ON e.org_id=c.org_id AND e.id=c.class_enrollment_id
      JOIN class_sessions s ON s.org_id=c.org_id AND s.id=${input.sessionId} AND s.status='scheduled'
      JOIN class_offerings o ON o.org_id=s.org_id AND o.id=s.class_offering_id
      WHERE c.org_id=${context.orgId} AND c.id=${input.creditId} FOR UPDATE OF c`.execute(trx);
    const row = credit.rows[0];
    if (!row || row.status !== 'available' || dateOnly(row.expires_on) < dependencies.clock().toISOString().slice(0, 10)) throw new ClassError(404, 'CREDIT_UNAVAILABLE', 'Make-up credit is no longer available');
    if (row.active_enrollment_count >= row.capacity) throw new ClassError(409, 'SESSION_FULL', 'Class capacity has been reached');
    if (row.offering_id !== row.target_offering_id) {
      const levels = await sql<{ source_level: string; target_level: string }>`SELECT source.level AS source_level,target.level AS target_level
        FROM class_offerings source,class_offerings target WHERE source.org_id=${context.orgId} AND target.org_id=${context.orgId}
          AND source.id=${row.offering_id} AND target.id=${row.target_offering_id}`.execute(trx);
      if (levels.rows[0]?.source_level !== levels.rows[0]?.target_level) throw new ClassError(409, 'MAKEUP_INELIGIBLE', 'Make-up must be booked in an eligible class level');
    }
    const link = await sql<{ id: string }>`SELECT hm.id FROM household_members hm JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
      WHERE hm.org_id=${context.orgId} AND hm.household_id=${row.household_id} AND pal.account_id=${context.actor.accountId} AND pal.relationship IN ('guardian','self') AND pal.revoked_at IS NULL`.execute(trx);
    if (!link.rows[0]) throw new ClassError(404, 'NOT_FOUND', 'Family enrollment not found');
    const id = randomUUID();
    await sql`INSERT INTO class_makeup_bookings(id,org_id,makeup_credit_id,class_session_id,status,booked_by)
      VALUES (${id},${context.orgId},${input.creditId},${input.sessionId},'booked',${context.actor.accountId})`.execute(trx);
    await sql`UPDATE class_makeup_credits SET status='booked',version=version+1,updated_at=now() WHERE org_id=${context.orgId} AND id=${input.creditId}`.execute(trx);
    await appendAuditEvent(trx, context, { action: 'classes.makeup.booked', entityType: 'class_makeup_booking', entityId: id });
    return { id, sessionId: input.sessionId, creditId: input.creditId, status: 'booked' };
  });
}

export async function updateClassSkill(dependencies: ClassDependencies, context: OrgContext, input: { enrollmentId: string; skillDefinitionId: string; proficiency: 'not_started' | 'learning' | 'achieved' | 'mastered'; notes: string | null }) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const skill = await sql<{ id: string }>`SELECT sd.id FROM class_skill_definitions sd JOIN class_enrollments e ON e.org_id=sd.org_id
      JOIN class_offerings o ON o.org_id=e.org_id AND o.program_id=sd.program_id AND o.level=sd.level
      WHERE sd.org_id=${context.orgId} AND sd.id=${input.skillDefinitionId} AND e.id=${input.enrollmentId} AND sd.active=true`.execute(trx);
    if (!skill.rows[0]) throw new ClassError(404, 'NOT_FOUND', 'Skill or enrollment not found');
    const id = randomUUID();
    const row = await sql<{ id: string; version: number }>`INSERT INTO class_skill_records(id,org_id,class_enrollment_id,skill_definition_id,proficiency,evaluated_by,notes)
      VALUES (${id},${context.orgId},${input.enrollmentId},${input.skillDefinitionId},${input.proficiency},${context.actor.accountId},${input.notes})
      ON CONFLICT (org_id,class_enrollment_id,skill_definition_id) DO UPDATE SET proficiency=EXCLUDED.proficiency,evaluated_by=EXCLUDED.evaluated_by,evaluated_at=now(),notes=EXCLUDED.notes,version=class_skill_records.version+1,updated_at=now()
      RETURNING id,version`.execute(trx);
    const record = row.rows[0];
    if (!record) throw new ClassError(409, 'SKILL_CONFLICT', 'Skill update could not be saved');
    await appendAuditEvent(trx, context, { action: 'classes.skill.updated', entityType: 'class_skill_record', entityId: record.id, changes: { proficiency: { tier: 'sensitive', after: input.proficiency } } });
    return { id: record.id, enrollmentId: input.enrollmentId, skillDefinitionId: input.skillDefinitionId, proficiency: input.proficiency, version: record.version };
  });
}

export async function createLevelRecommendation(dependencies: ClassDependencies, context: OrgContext, input: { enrollmentId: string; nextOfferingId: string }) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const details = await sql<{ current_level: string; next_level: string; enrollment_id: string }>`SELECT current.level AS current_level,next.level AS next_level,e.id AS enrollment_id
      FROM class_enrollments e JOIN class_offerings current ON current.org_id=e.org_id AND current.id=e.class_offering_id
      JOIN class_offerings next ON next.org_id=e.org_id AND next.id=${input.nextOfferingId} AND next.program_id=current.program_id
      WHERE e.org_id=${context.orgId} AND e.id=${input.enrollmentId} AND e.status IN ('enrolled','trial')`.execute(trx);
    const row = details.rows[0];
    if (!row || row.current_level === row.next_level) throw new ClassError(404, 'NOT_FOUND', 'Valid next class level not found');
    const id = randomUUID();
    await sql`INSERT INTO class_level_recommendations(id,org_id,class_enrollment_id,from_level,recommended_level,next_offering_id,instructor_account_id)
      VALUES (${id},${context.orgId},${input.enrollmentId},${row.current_level},${row.next_level},${input.nextOfferingId},${context.actor.accountId})`.execute(trx);
    await appendAuditEvent(trx, context, { action: 'classes.level.recommended', entityType: 'class_level_recommendation', entityId: id });
    return { id, enrollmentId: input.enrollmentId, fromLevel: row.current_level, recommendedLevel: row.next_level, status: 'pending_guardian' };
  });
}

export async function decideLevelRecommendation(dependencies: ClassDependencies, context: OrgContext, recommendationId: string, decision: 'confirm' | 'decline', expectedVersion: number) {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const recommendation = await sql<{ id: string; enrollment_id: string; next_offering_id: string | null; household_id: string; version: number; status: string }>`SELECT r.id,r.class_enrollment_id AS enrollment_id,r.next_offering_id,e.household_id,r.version,r.status
      FROM class_level_recommendations r JOIN class_enrollments e ON e.org_id=r.org_id AND e.id=r.class_enrollment_id
      WHERE r.org_id=${context.orgId} AND r.id=${recommendationId} FOR UPDATE`.execute(trx);
    const row = recommendation.rows[0];
    if (!row || row.status !== 'pending_guardian' || row.version !== expectedVersion) throw new ClassError(404, 'NOT_FOUND', 'Level recommendation not found');
    const guardian = await sql<{ id: string }>`SELECT hm.id FROM household_members hm JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
      WHERE hm.org_id=${context.orgId} AND hm.household_id=${row.household_id} AND pal.account_id=${context.actor.accountId}
        AND pal.relationship IN ('guardian','self') AND pal.revoked_at IS NULL`.execute(trx);
    if (!guardian.rows[0]) throw new ClassError(404, 'NOT_FOUND', 'Level recommendation not found');
    const status = decision === 'confirm' ? 'confirmed' : 'declined';
    await sql`UPDATE class_level_recommendations SET status=${status},guardian_decision_by=${context.actor.accountId},guardian_decision_at=${dependencies.clock()},version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${recommendationId} AND version=${expectedVersion}`.execute(trx);
    if (decision === 'confirm' && row.next_offering_id) {
      await sql`UPDATE class_enrollments SET class_offering_id=${row.next_offering_id},version=version+1,updated_at=now()
        WHERE org_id=${context.orgId} AND id=${row.enrollment_id}`.execute(trx);
      await sql`UPDATE class_tuition_subscriptions subscription SET amount_cents=(tier->>'amountCents')::bigint,version=subscription.version+1,updated_at=now()
        FROM class_offerings offering CROSS JOIN LATERAL jsonb_array_elements(offering.tuition_tiers) tier
        WHERE subscription.org_id=${context.orgId} AND subscription.class_enrollment_id=${row.enrollment_id}
          AND offering.org_id=subscription.org_id AND offering.id=${row.next_offering_id} AND tier->>'key'=(SELECT billing_tier FROM class_enrollments WHERE org_id=${context.orgId} AND id=${row.enrollment_id})`.execute(trx);
      await sql`UPDATE class_level_recommendations SET status='applied',applied_at=${dependencies.clock()},version=version+1,updated_at=now()
        WHERE org_id=${context.orgId} AND id=${recommendationId}`.execute(trx);
    }
    await appendAuditEvent(trx, context, { action: `classes.level.${status}`, entityType: 'class_level_recommendation', entityId: recommendationId });
    return { id: recommendationId, status: decision === 'confirm' ? 'applied' : status };
  });
}

export async function withdrawClassEnrollment(dependencies: ClassDependencies, context: OrgContext, offeringId: string, enrollmentId: string, noticeOn: string) {
  const today = dependencies.clock().toISOString().slice(0, 10);
  if (noticeOn < today) throw new ClassError(422, 'INVALID_NOTICE_DATE', 'Withdrawal notice cannot be backdated');
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const enrollment = await sql<{ id: string; household_id: string; status: string; subscription_id: string | null; amount_cents: number | null }>`SELECT e.id,e.household_id,e.status,s.id AS subscription_id,s.amount_cents
      FROM class_enrollments e LEFT JOIN class_tuition_subscriptions s ON s.org_id=e.org_id AND s.class_enrollment_id=e.id
      WHERE e.org_id=${context.orgId} AND e.id=${enrollmentId} AND e.class_offering_id=${offeringId} FOR UPDATE OF e`.execute(trx);
    const row = enrollment.rows[0];
    if (!row || !['enrolled','trial','withdrawal_pending'].includes(row.status)) throw new ClassError(404, 'NOT_FOUND', 'Class enrollment not found');
    const guardian = await sql<{ id: string }>`SELECT hm.id FROM household_members hm JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
      WHERE hm.org_id=${context.orgId} AND hm.household_id=${row.household_id} AND pal.account_id=${context.actor.accountId}
        AND pal.relationship IN ('guardian','self') AND pal.revoked_at IS NULL`.execute(trx);
    if (!guardian.rows[0]) throw new ClassError(404, 'NOT_FOUND', 'Class enrollment not found');
    const sessionRows = await sql<{ local_date: Date | string }>`SELECT local_date FROM class_sessions s JOIN class_enrollments e ON e.org_id=s.org_id
      JOIN class_offerings o ON o.org_id=e.org_id AND o.id=e.class_offering_id
      WHERE s.org_id=${context.orgId} AND e.id=${enrollmentId} AND s.class_offering_id=${offeringId} AND s.status='scheduled'
        AND s.local_date BETWEEN ${monthStart(today)} AND ${monthEnd(today)} ORDER BY s.local_date`.execute(trx);
    const refundQuoteCents = row.amount_cents === null ? 0 : withdrawalRefund(Number(row.amount_cents), sessionRows.rows.map((item) => dateOnly(item.local_date)), noticeOn);
    await sql`UPDATE class_enrollments SET status='withdrawal_pending',withdrawal_notice_on=${noticeOn},version=version+1,updated_at=now()
      WHERE org_id=${context.orgId} AND id=${enrollmentId}`.execute(trx);
    if (row.subscription_id) {
      await sql`UPDATE class_tuition_subscriptions SET status='canceled',version=version+1,updated_at=now()
        WHERE org_id=${context.orgId} AND id=${row.subscription_id}`.execute(trx);
    }
    await appendAuditEvent(trx, context, { action: 'classes.enrollment.withdrawal_notice', entityType: 'class_enrollment', entityId: enrollmentId, changes: { withdrawalNoticeOn: { tier: 'internal', after: noticeOn }, refundQuoteCents: { tier: 'internal', after: refundQuoteCents } } });
    return { enrollmentId, status: 'withdrawal_pending', noticeOn, refundQuoteCents, refundStatus: 'review_required' };
  });
}

export async function runClassTuitionBillingForOrganizations(dependencies: ClassDependencies, organizationIds: readonly string[], now = dependencies.clock()): Promise<{ invoiced: number; skipped: number }> {
  let invoiced = 0;
  let skipped = 0;
  for (const orgId of organizationIds) {
    const context: OrgContext = { orgId, actor: { accountId: '0199a1c0-0000-7000-8000-000000000001' } };
    const withOrg = createWithOrg(dependencies.database);
    const due = await withOrg(context, (trx) => sql<{ subscription_id: string; enrollment_id: string; household_id: string; person_id: string; billing_day: number; amount_cents: number; currency: string; next_invoice_on: Date; level: string; tier_name: string; account_id: string | null }>`SELECT s.id AS subscription_id,e.id AS enrollment_id,e.household_id,e.person_id,s.billing_day,s.amount_cents,s.currency,s.next_invoice_on,
      o.level,e.billing_tier AS tier_name,
      (SELECT pal.account_id FROM household_members hm JOIN person_account_links pal ON pal.org_id=hm.org_id AND pal.person_id=hm.person_id
        WHERE hm.org_id=e.org_id AND hm.household_id=e.household_id AND hm.financially_responsible AND pal.relationship IN ('guardian','self') AND pal.revoked_at IS NULL
        ORDER BY hm.is_primary_contact DESC,pal.account_id LIMIT 1) AS account_id
      FROM class_tuition_subscriptions s JOIN class_enrollments e ON e.org_id=s.org_id AND e.id=s.class_enrollment_id
      JOIN class_offerings o ON o.org_id=e.org_id AND o.id=e.class_offering_id
      WHERE s.org_id=${orgId} AND s.status IN ('active','past_due') AND s.next_invoice_on<=${now.toISOString().slice(0, 10)}
        AND e.status IN ('enrolled','withdrawal_pending') ORDER BY s.next_invoice_on,s.id FOR UPDATE OF s`.execute(trx));
    for (const row of due.rows) {
      if (!row.account_id) { skipped += 1; continue; }
      const dueOn = dateOnly(row.next_invoice_on);
      const creationKey = creationUuid(`class-tuition:${row.subscription_id}:${dueOn}`);
      const invoice = await new PostgresInvoiceRepository(dependencies.database, context).issue({
        orgId, accountId: row.account_id, householdId: row.household_id, source: 'tuition', dueOn,
        memo: `${row.level} class monthly tuition`, creationKey,
        lines: [{ kind: 'tuition', description: `${row.level} class monthly tuition`, amountCents: Number(row.amount_cents), refundable: true }],
      });
      const next = Temporal.PlainDate.from(dueOn).add({ months: 1 }).toString();
      await withOrg(context, async (trx) => {
        await sql`UPDATE class_tuition_subscriptions SET last_invoice_id=${invoice.id},last_billing_key=${creationKey},next_invoice_on=${next},status='active',version=version+1,updated_at=now()
          WHERE org_id=${orgId} AND id=${row.subscription_id} AND next_invoice_on=${dueOn}`.execute(trx);
        await appendAuditEvent(trx, context, { action: 'classes.tuition.invoiced', entityType: 'class_tuition_subscription', entityId: row.subscription_id, changes: { invoiceId: { tier: 'internal', after: invoice.id }, amountCents: { tier: 'internal', after: invoice.totalCents } } });
      });
      invoiced += 1;
    }
  }
  return { invoiced, skipped };
}

export async function runClassTuitionBilling() {
  const { getDatabase } = await import('../../db/kysely');
  const { getPlatformAdminDatabase } = await import('../platform/admin');
  const admin = getPlatformAdminDatabase();
  const orgs = await sql<{ id: string }>`SELECT id FROM organizations WHERE status='active' ORDER BY id`.execute(admin);
  return runClassTuitionBillingForOrganizations({ database: getDatabase(), clock: () => new Date() }, orgs.rows.map((row) => row.id));
}
