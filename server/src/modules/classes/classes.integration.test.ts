import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { orgToday } from '@shared/dates';
import { gymnastics } from '@shared/sport/templates/gymnastics';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import type { OrgContext } from '../../db/withOrg';
import { createWithOrg } from '../../db/withOrg';

import {
  requireClassStaff,
  requireGuardian,
  requireLinkedPerson,
  requireMember,
  requireSessionStaffOrInstructor,
} from './access';
import { PostgresClassAttendance } from './attendance';
import { PostgresClassBookings } from './bookings';
import { PostgresAcademyDashboard } from './dashboard';
import { PostgresClassEnrollments } from './enrollments';
import {
  AgeIneligibleError,
  ClassesAccessError,
  ClassesConflictError,
  ClassesNotFoundError,
} from './errors';
import { PostgresClassOfferings } from './offerings';
import { PostgresClassPromotions } from './promotions';
import { PostgresClassSchedules } from './schedules';
import { PostgresClassSessions } from './sessions';
import { PostgresClassSkills } from './skills';
import {
  buildTuitionLines,
  PostgresTuitionSubscriptions,
  tuitionForOffering,
} from './tuition';
import { runTuitionBilling } from './tuition-job';

const orgA = randomUUID();
const orgB = randomUUID();
const ownerA = randomUUID();
const guardianA = randomUUID();
const familyOnlyAccount = randomUUID();
const memberOnly = randomUUID();
const ownerB = randomUUID();
const instructorPersonA = randomUUID();
const guardianPersonA = randomUUID();
const childA1 = randomUUID();
const childA2 = randomUUID();
const childA3 = randomUUID();
const childA4 = randomUUID();
const householdA = randomUUID();
const seasonA = randomUUID();
const profileA = randomUUID();
const programA = randomUUID();
const seasonB = randomUUID();
const profileB = randomUUID();
const programB = randomUUID();
const organizationTimezone = 'America/Chicago';
const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

const ownerContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: ownerA },
};
const guardianContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: guardianA },
};
const familyOnlyContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: familyOnlyAccount },
};
const memberContext: OrgContext = {
  orgId: orgA,
  actor: { accountId: memberOnly },
};
const foreignContext: OrgContext = {
  orgId: orgB,
  actor: { accountId: ownerB },
};

let database: Kysely<DB>;
const withOrg = () => createWithOrg(database);

function services(context: OrgContext) {
  return {
    offerings: new PostgresClassOfferings(database, context),
    schedules: new PostgresClassSchedules(database, context),
    sessions: new PostgresClassSessions(database, context),
    enrollments: new PostgresClassEnrollments(database, context),
    attendance: new PostgresClassAttendance(database, context),
    bookings: new PostgresClassBookings(database, context),
    skills: new PostgresClassSkills(database, context),
    promotions: new PostgresClassPromotions(database, context),
    subscriptions: new PostgresTuitionSubscriptions(database, context),
  };
}

function must<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined)
    throw new Error(`Missing ${label}`);
  return value;
}

const offeringBody = {
  programId: programA,
  skillLevelId: null,
  name: 'Beginner Gymnastics',
  description: null,
  ageMinMonths: null,
  ageMaxMonths: null,
  capacity: 8,
  instructorRatio: 8,
  billing: 'monthly' as const,
  priceCents: 12_000,
  punchCardUses: null,
  tuitionTiers: [
    { maxClassesPerWeek: 1, amountCents: 12_000 },
    { maxClassesPerWeek: 2, amountCents: 22_000 },
    { maxClassesPerWeek: null, amountCents: 30_000 },
  ],
  annualFeeCents: 0,
  trialAllowed: true,
  trialPriceCents: 2_500,
  makeupPolicy: {
    creditsPerTerm: 4,
    expiryDays: 60,
    eligibleLevelIds: null,
    eligibleOfferingIds: null,
  },
  siblingDiscountBps: [0, 1_000],
  status: 'active' as const,
};

async function insertFixtures(): Promise<void> {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO organizations (id, slug, name, kind, timezone, status)
       VALUES ($1, $2, 'Academy Test A', 'club', $5, 'active'),
              ($3, $4, 'Academy Test B', 'club', $5, 'active')`,
      [
        orgA,
        `academy-a-${orgA.slice(0, 8)}`,
        orgB,
        `academy-b-${orgB.slice(0, 8)}`,
        organizationTimezone,
      ],
    );
    await admin.query(
      `INSERT INTO accounts (id, email, first_name, last_name, date_of_birth, email_verified_at)
       VALUES ($1, $5, 'Owner', 'One', '1985-01-01', now()),
              ($2, $6, 'Guardian', 'One', '1986-01-01', now()),
              ($3, $7, 'Member', 'Only', '1987-01-01', now()),
              ($4, $8, 'Owner', 'Two', '1988-01-01', now())`,
      [
        ownerA,
        guardianA,
        memberOnly,
        ownerB,
        `owner-a-${orgA.slice(0, 6)}@example.invalid`,
        `guardian-a-${orgA.slice(0, 6)}@example.invalid`,
        `member-a-${orgA.slice(0, 6)}@example.invalid`,
        `owner-b-${orgB.slice(0, 6)}@example.invalid`,
      ],
    );
    await admin.query(
      `INSERT INTO accounts (id, email, first_name, last_name, date_of_birth, email_verified_at)
       VALUES ($1, $2, 'Family', 'Only', '1987-01-01', now())`,
      [familyOnlyAccount, `family-only-${orgA.slice(0, 6)}@example.invalid`],
    );
    await admin.query(
      `INSERT INTO org_memberships (id, org_id, account_id, status, joined_at)
       VALUES ($1, $2, $3, 'active', now()),
              ($4, $2, $5, 'active', now()),
              ($6, $2, $7, 'active', now()),
              ($8, $9, $10, 'active', now())`,
      [
        randomUUID(),
        orgA,
        ownerA,
        randomUUID(),
        guardianA,
        randomUUID(),
        memberOnly,
        randomUUID(),
        orgB,
        ownerB,
      ],
    );
    await admin.query(
      `INSERT INTO role_assignments
        (id, org_id, account_id, role, scope_type, pending_mfa)
       VALUES ($1, $2, $3, 'owner', 'org', false),
              ($4, $5, $6, 'owner', 'org', false)`,
      [randomUUID(), orgA, ownerA, randomUUID(), orgB, ownerB],
    );
    await admin.query(
      `INSERT INTO people (id, org_id, first_name, last_name, date_of_birth)
       VALUES ($1, $2, 'Instructor', 'Kim', '1990-05-01'),
              ($3, $2, 'Guardian', 'One', '1986-01-01'),
              ($4, $2, 'Gymnast', 'One', '2018-03-15'),
              ($5, $2, 'Gymnast', 'Two', '2019-06-20'),
              ($6, $2, 'Gymnast', 'Three', '2017-11-05'),
              ($7, $2, 'Gymnast', 'Four', '2016-09-12'),
              ($8, $9, 'Other', 'Org', '2018-01-01')`,
      [
        instructorPersonA,
        orgA,
        guardianPersonA,
        childA1,
        childA2,
        childA3,
        childA4,
        randomUUID(),
        orgB,
      ],
    );
    await admin.query(
      `INSERT INTO person_account_links
        (id, org_id, person_id, account_id, relationship, verified_at)
       VALUES ($1, $2, $3, $4, 'self', now()),
              ($5, $2, $6, $4, 'guardian', now()),
              ($7, $2, $8, $4, 'guardian', now()),
              ($9, $2, $10, $4, 'guardian', now()),
              ($11, $2, $12, $4, 'guardian', now()),
              ($13, $2, $15, $14, 'guardian', now())`,
      [
        randomUUID(),
        orgA,
        guardianPersonA,
        guardianA,
        randomUUID(),
        childA1,
        randomUUID(),
        childA2,
        randomUUID(),
        childA3,
        randomUUID(),
        childA4,
        randomUUID(),
        familyOnlyAccount,
        childA1,
      ],
    );
    await admin.query(
      `INSERT INTO households (id, org_id, name)
       VALUES ($1, $2, 'Family One')`,
      [householdA, orgA],
    );
    await admin.query(
      `INSERT INTO household_members
        (id, org_id, household_id, person_id, role, can_pick_up)
       VALUES ($1, $2, $3, $4, 'guardian', true),
              ($5, $2, $3, $6, 'athlete', false),
              ($7, $2, $3, $8, 'athlete', false),
              ($9, $2, $3, $10, 'athlete', false),
              ($11, $2, $3, $12, 'athlete', false)`,
      [
        randomUUID(),
        orgA,
        householdA,
        guardianPersonA,
        randomUUID(),
        childA1,
        randomUUID(),
        childA2,
        randomUUID(),
        childA3,
        randomUUID(),
        childA4,
      ],
    );
    for (const [org, season, profile, program] of [
      [orgA, seasonA, profileA, programA],
      [orgB, seasonB, profileB, programB],
    ] as const) {
      await admin.query(
        `INSERT INTO seasons (id, org_id, name, starts_on, ends_on)
         VALUES ($1, $2, 'Academy Season', '2026-01-01', '2027-12-31')`,
        [season, org],
      );
      await admin.query(
        `INSERT INTO sport_profiles (id, org_id, name, profile)
         VALUES ($1, $2, 'Gymnastics', $3)`,
        [profile, org, JSON.stringify(gymnastics)],
      );
      await admin.query(
        `INSERT INTO programs
          (id, org_id, season_id, sport_profile_id, mode, name, slug,
           starts_on, ends_on, status, visibility)
         VALUES ($1, $2, $3, $4, 'class', 'Gymnastics Academy', $5,
           '2026-01-01', '2027-12-31', 'published', 'public')`,
        [program, org, season, profile, `gym-${program.slice(0, 8)}`],
      );
    }
  } finally {
    await admin.end();
  }
}

function thisMonthRange(now: Temporal.Instant = Temporal.Now.instant()): {
  start: string;
  end: string;
  today: string;
} {
  const today = orgToday(organizationTimezone, now);
  const start = Temporal.PlainDate.from(today).with({ day: 1 });
  const end = start.add({ months: 4 }).subtract({ days: 1 });
  return { start: start.toString(), end: end.toString(), today };
}

function weekdayFor(date: string): (typeof weekdays)[number] {
  const weekday = weekdays[Temporal.PlainDate.from(date).dayOfWeek - 1];
  if (!weekday) throw new Error('Could not resolve fixture weekday');
  return weekday;
}

describe('academy classes integration', () => {
  let offeringId: string;
  let scheduleId: string;
  let firstSessionId: string;
  let secondOfferingId: string;

  it('uses the organization date when UTC has advanced to the next day', () => {
    const utcMidnightBoundary = Temporal.Instant.from('2026-09-28T01:14:00Z');

    expect(orgToday(organizationTimezone, utcMidnightBoundary)).toBe(
      '2026-09-27',
    );
    expect(thisMonthRange(utcMidnightBoundary)).toEqual({
      start: '2026-09-01',
      end: '2026-12-31',
      today: '2026-09-27',
    });
  });

  beforeAll(async () => {
    database = createDatabase(
      must(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL'),
    );
    await insertFixtures();
  });

  it('prices family tiers and per-sibling discounts in integer cents', () => {
    expect(
      tuitionForOffering(
        1,
        [10_000, 8_000, 6_000],
        [
          { maxClassesPerWeek: 2, amountCents: 45_000 },
          { maxClassesPerWeek: null, amountCents: 80_000 },
        ],
        [0, 1_000],
      ),
    ).toBe(45_000);
    expect(
      tuitionForOffering(
        3,
        [10_000, 8_000, 6_000],
        [
          { maxClassesPerWeek: 2, amountCents: 45_000 },
          { maxClassesPerWeek: null, amountCents: 80_000 },
        ],
        [0, 1_000],
      ),
    ).toBe(80_000);
    expect(
      tuitionForOffering(3, [10_000, 8_000, 6_000], [], [1_000, 2_000]),
    ).toBe(22_000);
  });

  afterAll(async () => {
    await database.destroy();
  });

  it('rejects non-staff reads and mutations', async () => {
    await expect(
      requireClassStaff(database, memberContext),
    ).rejects.toBeInstanceOf(ClassesAccessError);
    await requireClassStaff(database, ownerContext);
  });

  it('allows a verified linked family account without org membership', async () => {
    await expect(
      requireMember(database, familyOnlyContext),
    ).resolves.toBeUndefined();
    await expect(
      requireLinkedPerson(database, familyOnlyContext, childA1),
    ).resolves.toBeUndefined();
    await expect(
      requireLinkedPerson(database, familyOnlyContext, childA2),
    ).rejects.toBeInstanceOf(ClassesAccessError);
    await expect(
      requireMember(database, {
        orgId: orgB,
        actor: { accountId: familyOnlyAccount },
      }),
    ).rejects.toBeInstanceOf(ClassesAccessError);
  });

  it('creates an offering, schedule and materialized sessions', async () => {
    const { offerings, schedules, sessions } = services(ownerContext);
    const offering = await offerings.create(offeringBody);
    expect(offering.id).toBeTruthy();
    offeringId = offering.id;
    const { start, end } = thisMonthRange();
    const schedule = await schedules.create(
      offeringId,
      {
        recurrence: {
          kind: 'weekly',
          interval: 1,
          byDay: ['MO', 'WE', 'FR'],
          startsOn: start,
          endsOn: end,
          exceptions: [],
          additions: [],
        },
        startTime: '16:00',
        durationMinutes: 60,
        timezone: 'America/Chicago',
        spaceId: null,
        locationText: 'Main gym',
        termStart: start,
        termEnd: end,
      },
      [],
    );
    scheduleId = schedule.id;
    expect(schedule.sessionCount).toBeGreaterThan(10);
    const list = await sessions.list({
      offeringId,
      from: start,
      to: end,
      limit: 200,
    });
    expect(list.length).toBe(schedule.sessionCount);
    firstSessionId = must(list[0]).id;
    expect(must(list[0]).offeringName).toBe('Beginner Gymnastics');
  });

  it('assigns an instructor and reports compliance state', async () => {
    const { schedules, sessions } = services(ownerContext);
    const assigned = await schedules.assignInstructor(scheduleId, {
      personId: instructorPersonA,
    });
    expect(assigned.id).toBeTruthy();
    const roster = await schedules.instructorRoster(scheduleId);
    expect(roster).toHaveLength(1);
    expect(must(roster[0]).personId).toBe(instructorPersonA);
    const future = await sessions.list({
      scheduleId,
      from: thisMonthRange().today,
      to: thisMonthRange().end,
      limit: 200,
    });
    const next = future.find((item) => new Date(item.startsAt) > new Date());
    expect(next).toBeTruthy();
    expect(
      await sessions.assignSubstitute(must(next).id, instructorPersonA),
    ).toEqual({
      personId: instructorPersonA,
      name: 'Instructor Kim',
    });
  });

  it('warns when a scheduled class exceeds its instructor ratio', async () => {
    const { offerings, schedules, sessions } = services(ownerContext);
    const offering = await offerings.create({
      ...offeringBody,
      name: 'Ratio monitoring class',
      billing: 'term',
      priceCents: 0,
      tuitionTiers: [],
      siblingDiscountBps: [],
      instructorRatio: 8,
      trialAllowed: false,
    });
    const startsOn = Temporal.PlainDate.from(thisMonthRange().today).add({
      days: 1,
    });
    const endsOn = startsOn.add({ days: 14 });
    const schedule = await schedules.create(
      offering.id,
      {
        recurrence: {
          kind: 'weekly',
          interval: 1,
          byDay: [weekdayFor(startsOn.toString())],
          startsOn: startsOn.toString(),
          endsOn: endsOn.toString(),
          exceptions: [],
          additions: [],
        },
        startTime: '16:00',
        durationMinutes: 60,
        timezone: organizationTimezone,
        spaceId: null,
        locationText: 'Main gym',
        termStart: startsOn.toString(),
        termEnd: endsOn.toString(),
      },
      [],
    );
    await schedules.assignInstructor(schedule.id, {
      personId: instructorPersonA,
    });

    const additionalPeople = Array.from({ length: 5 }, () => randomUUID());
    const ratioPeople = [
      childA1,
      childA2,
      childA3,
      childA4,
      ...additionalPeople,
    ];
    await withOrg()(ownerContext, async (trx) => {
      await trx
        .insertInto('people')
        .values(
          additionalPeople.map((id, index) => ({
            id,
            org_id: orgA,
            first_name: `Ratio${String(index)}`,
            last_name: 'Gymnast',
            date_of_birth: '2012-01-01',
          })),
        )
        .execute();
      await trx
        .insertInto('class_enrollments')
        .values(
          ratioPeople.map((personId) => ({
            id: randomUUID(),
            org_id: orgA,
            class_offering_id: offering.id,
            person_id: personId,
            household_id: householdA,
            account_id: ownerA,
            status: 'active' as const,
            starts_on: startsOn.toString(),
            classes_per_week: 1,
          })),
        )
        .execute();
    });

    const upcoming = await sessions.list({
      scheduleId: schedule.id,
      from: startsOn.toString(),
      to: endsOn.toString(),
      limit: 100,
    });
    const session = must(upcoming[0]);
    const dashboard = await new PostgresAcademyDashboard(
      database,
      ownerContext,
    ).get();
    expect(dashboard.ratioWarnings).toContainEqual(
      expect.objectContaining({
        classSessionId: session.id,
        attendees: 9,
        instructors: 1,
        requiredInstructors: 2,
      }),
    );
  });

  it('enrolls a child with a tuition subscription and prorated invoice', async () => {
    const { enrollments, subscriptions } = services(guardianContext);
    const result = await enrollments.enroll(
      {
        classOfferingId: offeringId,
        personId: childA1,
        householdId: householdA,
        startsOn: thisMonthRange().today,
        classesPerWeek: 2,
        trial: false,
        trialSessionId: null,
        paymentMethodId: null,
        autopay: false,
        billingDay: 1,
      },
      randomUUID(),
      { staff: false },
    );
    expect(result.enrollment?.status).toBe('active');
    expect(result.subscriptionId).toBeTruthy();
    const subscription = await subscriptions.get(must(result.subscriptionId));
    expect(subscription.activeEnrollments).toBeGreaterThanOrEqual(1);
    expect(result.invoiceId).toBeTruthy();
    expect(result.amountDueCents).not.toBeNull();
  });

  it('is replay-safe under an Idempotency-Key', async () => {
    const { enrollments } = services(guardianContext);
    const operationKey = randomUUID();
    const body = {
      classOfferingId: offeringId,
      personId: childA2,
      householdId: householdA,
      startsOn: thisMonthRange().today,
      classesPerWeek: 1,
      trial: false,
      trialSessionId: null,
      paymentMethodId: null,
      autopay: false,
      billingDay: 1,
    };
    const first = await enrollments.enroll(body, operationKey, {
      staff: false,
    });
    const second = await enrollments.enroll(body, operationKey, {
      staff: false,
    });
    expect(second.enrollment?.id).toBe(first.enrollment?.id);
    expect(second.invoiceId).toBe(first.invoiceId);
  });

  it('enforces the age window', async () => {
    const { offerings, enrollments } = services(ownerContext);
    const baby = await offerings.create({
      ...offeringBody,
      name: 'Preschool Tumbling',
      ageMinMonths: 36,
      ageMaxMonths: 60,
      capacity: 5,
    });
    await expect(
      enrollments.enroll(
        {
          classOfferingId: baby.id,
          personId: childA1,
          householdId: householdA,
          startsOn: thisMonthRange().today,
          classesPerWeek: 1,
          trial: false,
          trialSessionId: null,
          paymentMethodId: null,
          autopay: false,
          billingDay: 1,
        },
        randomUUID(),
        { staff: true },
      ),
    ).rejects.toBeInstanceOf(AgeIneligibleError);
  });

  it('waitlists when capacity fills and offers the next spot', async () => {
    const { offerings, enrollments } = services(ownerContext);
    const tiny = await offerings.create({
      ...offeringBody,
      name: 'Tiny Class',
      capacity: 1,
      billing: 'term' as const,
      priceCents: 40_000,
    });
    const body = {
      classOfferingId: tiny.id,
      householdId: householdA,
      startsOn: thisMonthRange().today,
      classesPerWeek: 1,
      trial: false,
      trialSessionId: null,
      paymentMethodId: null,
      autopay: false,
      billingDay: 1,
    };
    const first = await enrollments.enroll(
      { ...body, personId: childA2 },
      randomUUID(),
      { staff: true },
    );
    expect(first.enrollment).toBeTruthy();
    const second = await enrollments.enroll(
      { ...body, personId: childA3 },
      randomUUID(),
      { staff: true },
    );
    expect(second.enrollment).toBeNull();
    expect(second.waitlistEntry?.position).toBe(1);
    const entries = await enrollments.waitlist(tiny.id);
    expect(entries).toHaveLength(1);
    expect(must(entries[0]).personId).toBe(childA3);
    expect(await enrollments.waitlistForAccount(ownerA)).toHaveLength(0);
    expect(await enrollments.waitlistForAccount(guardianA)).toHaveLength(0);
    await expect(
      services(memberContext).enrollments.acceptWaitlistOffer(
        must(second.waitlistEntry).id,
        { ...body, personId: childA3 },
        randomUUID(),
        { staff: false },
      ),
    ).rejects.toBeInstanceOf(ClassesNotFoundError);
  });

  it('marks attendance, grants make-up credit, books another session', async () => {
    const { attendance, bookings, sessions, offerings, schedules } =
      services(ownerContext);
    // A second offering the make-up policy can target.
    const second = await offerings.create({
      ...offeringBody,
      name: 'Intermediate Gymnastics',
      capacity: 8,
    });
    secondOfferingId = second.id;
    const { start, end } = thisMonthRange();
    await schedules.create(
      second.id,
      {
        recurrence: {
          kind: 'weekly',
          interval: 1,
          byDay: ['TU', 'TH'],
          startsOn: start,
          endsOn: end,
          exceptions: [],
          additions: [],
        },
        startTime: '17:00',
        durationMinutes: 60,
        timezone: 'America/Chicago',
        spaceId: null,
        locationText: 'Main gym',
        termStart: start,
        termEnd: end,
      },
      [],
    );
    // Enroll childA1 (already enrolled in offering one) in the second offering
    // is not required — the credit from offering one books into the second.
    const marked = await attendance.mark(firstSessionId, {
      marks: [{ personId: childA1, status: 'absent' }],
    });
    expect(marked.creditsIssued).toBe(1);
    const credits = await bookings.listMakeupCredits({ personId: childA1 });
    expect(credits).toHaveLength(1);
    expect(must(credits[0]).status).toBe('available');
    const eligible = await bookings.eligibleMakeupSessions(
      must(credits[0]).id,
      guardianA,
      { from: start, to: end, limit: 200 },
    );
    expect(eligible.map((item) => item.classOfferingId)).toContain(second.id);
    await expect(
      bookings.eligibleMakeupSessions(must(credits[0]).id, ownerA, {
        from: start,
        to: end,
        limit: 200,
      }),
    ).rejects.toBeInstanceOf(ClassesNotFoundError);
    const targets = await sessions.list({
      offeringId: second.id,
      from: start,
      to: end,
      limit: 200,
    });
    await expect(
      bookings.bookMakeup(must(credits[0]).id, must(targets[0]).id, ownerA),
    ).rejects.toBeInstanceOf(ClassesNotFoundError);
    const booked = await bookings.bookMakeup(
      must(credits[0]).id,
      must(targets[0]).id,
      guardianA,
    );
    expect(booked.status).toBe('booked');
    const roster = await withOrg()(ownerContext, (trx) =>
      services(ownerContext).sessions.roster(trx, must(targets[0]).id),
    );
    expect(
      roster.attendees.some(
        (a) => a.personId === childA1 && a.membership === 'makeup',
      ),
    ).toBe(true);
    // The credit is now used.
    const after = await bookings.listMakeupCredits({ personId: childA1 });
    expect(must(after[0]).status).toBe('used');
  });

  it('lists verified pickups and rejects an unauthorized pickup person', async () => {
    const { attendance } = services(ownerContext);
    const pickups = await attendance.pickupPeople(firstSessionId, childA1);
    expect(pickups).toContainEqual({
      personId: guardianPersonA,
      name: 'Guardian One',
    });
    expect(pickups.some((pickup) => pickup.personId === childA2)).toBe(false);
    await expect(
      attendance.checkOut(firstSessionId, childA1, guardianPersonA),
    ).rejects.toBeInstanceOf(ClassesConflictError);
    await attendance.checkIn(firstSessionId, childA1);
    await expect(
      attendance.checkOut(firstSessionId, childA1, childA2),
    ).rejects.toBeInstanceOf(ClassesConflictError);
    await attendance.checkOut(firstSessionId, childA1, guardianPersonA);
  });

  it('runs the monthly tuition job and issues an invoice', async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      // Make this month's billing period due without depending on the host's
      // timezone or catching up from before the enrollment existed.
      await admin.query(
        `UPDATE tuition_subscriptions SET next_bill_on = $2::date
         WHERE org_id = $1 AND status = 'active'`,
        [orgA, thisMonthRange().start],
      );
      const before = await admin.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM tuition_invoices WHERE org_id = $1`,
        [orgA],
      );
      const result = await runTuitionBilling(database, [orgA]);
      expect(result.billed).toBeGreaterThan(0);
      const after = await admin.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM tuition_invoices WHERE org_id = $1`,
        [orgA],
      );
      expect(must(after.rows[0]).count).toBeGreaterThan(
        must(before.rows[0]).count,
      );
    } finally {
      await admin.end();
    }
  });

  it('pauses and resumes an enrollment', async () => {
    const { enrollments } = services(ownerContext);
    const list = await enrollments.list({ personId: childA1, limit: 10 });
    const enrollment = list.items.find(
      (item) => item.classOfferingId === offeringId,
    );
    expect(enrollment).toBeTruthy();
    const paused = await enrollments.pause(must(enrollment).id, {
      pauseFrom: '2026-07-01',
      pauseTo: '2026-07-15',
      expectedVersion: must(enrollment).version,
    });
    expect(paused.status).toBe('paused');
    const resumed = await enrollments.resume(
      must(enrollment).id,
      paused.version,
    );
    expect(resumed.status).toBe('active');
  });

  it('withdraws with a notice period and refund credit', async () => {
    const { enrollments } = services(guardianContext);
    const list = await enrollments.list({ personId: childA1, limit: 10 });
    const target = list.items.find(
      (item) => item.classOfferingId === offeringId && item.status === 'active',
    );
    expect(target).toBeTruthy();
    const result = await enrollments.withdraw(
      must(target).id,
      {
        effectiveOn: null,
        reason: 'Moving',
        expectedVersion: must(target).version,
      },
      { staff: false },
      randomUUID(),
    );
    expect(result.enrollment.status).toBe('withdrawn');
    expect(result.billThrough).toBeTruthy();
  });

  it('recommends, approves and confirms a promotion', async () => {
    const { skills, promotions, enrollments, offerings } =
      services(ownerContext);
    const sync = await skills.syncFromProfile(profileA);
    expect(sync.levelsCreated).toBeGreaterThan(0);
    const levels = await skills.listLevels(profileA);
    expect(levels.length).toBeGreaterThanOrEqual(2);
    const targetOffering = await offerings.get(secondOfferingId);
    await offerings.update(secondOfferingId, {
      skillLevelId: must(levels[1]).id,
      expectedVersion: targetOffering.version,
    });
    const enrollment = (
      await enrollments.list({ personId: childA2, limit: 10 })
    ).items.find((item) => item.status === 'active');
    expect(enrollment).toBeTruthy();
    const recommended = await promotions.recommend({
      personId: childA2,
      toLevelId: must(levels[1]).id,
      note: 'Ready for the next level',
      targetClassOfferingId: secondOfferingId,
    });
    expect(recommended.status).toBe('recommended');
    const approved = await promotions.approve(
      recommended.id,
      recommended.version,
    );
    expect(approved.status).toBe('approved');
    const guardianNotification = await withOrg()(guardianContext, (trx) =>
      trx
        .selectFrom('notifications')
        .select('id')
        .where('account_id', '=', guardianA)
        .where('type', '=', 'registration.offered')
        .where(sql<boolean>`payload ->> 'resourceId' = ${recommended.id}`)
        .executeTakeFirst(),
    );
    expect(guardianNotification).toBeTruthy();
    const confirmed = await promotions.confirm(
      approved.id,
      { expectedVersion: approved.version },
      randomUUID(),
    );
    expect(['confirmed', 'completed']).toContain(confirmed.status);
    const moved = (
      await enrollments.list({ personId: childA2, limit: 20 })
    ).items.find((item) => item.classOfferingId === secondOfferingId);
    expect(moved).toBeTruthy();
    const pdf = await promotions.certificatePdf(confirmed.id);
    expect(pdf.byteLength).toBeGreaterThan(500);
  });

  it('defers a subscribed level change to the next bill without double charging', async () => {
    const { enrollments, promotions, skills, offerings } =
      services(guardianContext);
    const levels = await skills.listLevels(profileA);
    const nextLevel = must(levels[1]);
    const targetOffering = await offerings.get(secondOfferingId);
    await offerings.update(secondOfferingId, {
      tuitionTiers: [
        { maxClassesPerWeek: 1, amountCents: 15_000 },
        { maxClassesPerWeek: 2, amountCents: 28_000 },
        { maxClassesPerWeek: null, amountCents: 39_000 },
      ],
      expectedVersion: targetOffering.version,
    });
    const started = await enrollments.enroll(
      {
        classOfferingId: offeringId,
        personId: childA4,
        householdId: householdA,
        startsOn: thisMonthRange().today,
        classesPerWeek: 1,
        trial: false,
        trialSessionId: null,
        paymentMethodId: null,
        autopay: false,
        billingDay: 1,
      },
      randomUUID(),
      { staff: false },
    );
    expect(started.invoiceId).toBeTruthy();

    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      const before = await admin.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM invoices
         WHERE org_id = $1 AND household_id = $2`,
        [orgA, householdA],
      );
      const recommendation = await promotions.recommend({
        personId: childA4,
        toLevelId: nextLevel.id,
        targetClassOfferingId: secondOfferingId,
      });
      const approved = await promotions.approve(
        recommendation.id,
        recommendation.version,
      );
      const completed = await promotions.confirm(
        approved.id,
        { expectedVersion: approved.version },
        randomUUID(),
      );
      const after = await admin.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM invoices
         WHERE org_id = $1 AND household_id = $2`,
        [orgA, householdA],
      );
      expect(completed.status).toBe('completed');
      expect(must(after.rows[0]).count).toBe(must(before.rows[0]).count);
      const moved = (
        await enrollments.list({ personId: childA4, limit: 20 })
      ).items.find((item) => item.classOfferingId === secondOfferingId);
      expect(moved?.status).toBe('active');

      const subscriptionId = must(started.enrollment?.billingSubscriptionId);
      const nextMonth = Temporal.PlainDate.from(thisMonthRange().today)
        .with({ day: 1 })
        .add({ months: 1 });
      const nextBill = await withOrg()(guardianContext, async (trx) => {
        const active = await trx
          .selectFrom('class_enrollments')
          .select(['classes_per_week', 'status'])
          .where('org_id', '=', orgA)
          .where('class_offering_id', '=', secondOfferingId)
          .where('billing_subscription_id', '=', subscriptionId)
          .where('status', 'in', ['active', 'paused'])
          .execute();
        const { lines } = await buildTuitionLines(
          trx,
          guardianContext,
          subscriptionId,
          nextMonth.toString(),
          nextMonth.add({ months: 1 }).subtract({ days: 1 }).toString(),
        );
        return {
          classesPerWeek: active
            .filter((item) => item.status === 'active')
            .reduce((total, item) => total + item.classes_per_week, 0),
          tuitionCents: lines.find((line) =>
            line.description.startsWith(
              'Intermediate Gymnastics — monthly tuition',
            ),
          )?.amountCents,
        };
      });
      const expectedTierCents =
        nextBill.classesPerWeek <= 1
          ? 15_000
          : nextBill.classesPerWeek === 2
            ? 28_000
            : 39_000;
      expect(nextBill.tuitionCents).toBe(expectedTierCents);
    } finally {
      await admin.end();
    }
  });

  it('supports drop-in booking and punch cards', async () => {
    const { offerings, schedules, sessions, bookings } = services(ownerContext);
    const dropIn = await offerings.create({
      ...offeringBody,
      name: 'Open Gym',
      billing: 'drop_in' as const,
      priceCents: 1_500,
      capacity: 20,
    });
    const { start, end } = thisMonthRange();
    await schedules.create(
      dropIn.id,
      {
        recurrence: {
          kind: 'weekly',
          interval: 1,
          byDay: ['SA'],
          startsOn: start,
          endsOn: end,
          exceptions: [],
          additions: [],
        },
        startTime: '10:00',
        durationMinutes: 90,
        timezone: 'America/Chicago',
        spaceId: null,
        locationText: null,
        termStart: start,
        termEnd: end,
      },
      [],
    );
    const target = (
      await sessions.list({
        offeringId: dropIn.id,
        from: start,
        to: end,
        limit: 10,
      })
    )[0];
    const targetSession = must(target);
    const booked = await bookings.bookDropIn(
      targetSession.id,
      childA3,
      householdA,
      randomUUID(),
    );
    expect(booked.status).toBe('booked');
    expect(booked.invoiceId).toBeTruthy();
    await expect(
      services(memberContext).bookings.cancelBooking(
        booked.bookingId,
        memberOnly,
      ),
    ).rejects.toBeInstanceOf(ClassesNotFoundError);
    const unchangedBooking = await withOrg()(ownerContext, (trx) =>
      trx
        .selectFrom('class_session_bookings')
        .select('status')
        .where('org_id', '=', orgA)
        .where('id', '=', booked.bookingId)
        .executeTakeFirstOrThrow(),
    );
    expect(unchangedBooking.status).toBe('booked');

    const punch = await offerings.create({
      ...offeringBody,
      name: 'Tumble Punch',
      billing: 'punch_card' as const,
      punchCardUses: 5,
      priceCents: 6_000,
      capacity: 15,
    });
    await schedules.create(
      punch.id,
      {
        recurrence: {
          kind: 'weekly',
          interval: 1,
          byDay: ['SU'],
          startsOn: start,
          endsOn: end,
          exceptions: [],
          additions: [],
        },
        startTime: '11:00',
        durationMinutes: 60,
        timezone: 'America/Chicago',
        spaceId: null,
        locationText: null,
        termStart: start,
        termEnd: end,
      },
      [],
    );
    const purchased = await bookings.purchasePunchCard(
      punch.id,
      childA3,
      householdA,
      randomUUID(),
    );
    expect(purchased.punchCardId).toBeTruthy();
    const punchTarget = (
      await sessions.list({
        offeringId: punch.id,
        from: start,
        to: end,
        limit: 10,
      })
    )[0];
    const punchBooked = await bookings.bookPunchCard(
      must(punchTarget).id,
      purchased.punchCardId,
    );
    expect(punchBooked.status).toBe('booked');
    const cards = await bookings.listPunchCards({ personId: childA3 });
    expect(must(cards[0]).remainingUses).toBe(4);
    await expect(
      services(memberContext).bookings.bookPunchCard(
        must(punchTarget).id,
        purchased.punchCardId,
        memberOnly,
      ),
    ).rejects.toBeInstanceOf(ClassesNotFoundError);
  });

  it('does not treat a guardian link as an instructor identity', async () => {
    await withOrg()(ownerContext, async (trx) => {
      const session = await trx
        .selectFrom('class_sessions')
        .select('class_schedule_id')
        .where('org_id', '=', orgA)
        .where('id', '=', firstSessionId)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('class_instructors')
        .values({
          id: randomUUID(),
          org_id: orgA,
          class_schedule_id: session.class_schedule_id,
          person_id: instructorPersonA,
          status: 'active',
          added_by: ownerA,
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: randomUUID(),
          org_id: orgA,
          person_id: instructorPersonA,
          account_id: guardianA,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
    });

    await expect(
      requireSessionStaffOrInstructor(
        database,
        guardianContext,
        firstSessionId,
      ),
    ).rejects.toBeInstanceOf(ClassesAccessError);
  });

  it('does not leak data across tenants', async () => {
    const { offerings, enrollments, sessions } = services(foreignContext);
    const list = await offerings.list({ limit: 100 });
    expect(list.items).toHaveLength(0);
    const mine = await enrollments.list({ limit: 100 });
    expect(mine.items).toHaveLength(0);
    await expect(sessions.get(firstSessionId)).rejects.toBeInstanceOf(
      ClassesNotFoundError,
    );
    await expect(
      requireGuardian(database, guardianContext, childA1),
    ).resolves.toBeUndefined();
    await expect(
      requireLinkedPerson(database, memberContext, childA1),
    ).rejects.toBeInstanceOf(ClassesAccessError);
  });
});
