import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { PostgresClassEnrollments } from '../server/src/modules/classes/enrollments';
import { PostgresClassOfferings } from '../server/src/modules/classes/offerings';
import { PostgresClassSchedules } from '../server/src/modules/classes/schedules';
import { createTestFactories } from '../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');
const timezone = 'America/Chicago';
const weekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

function localDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(value);
}

function localTime(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
}

function localWeekday(date: string): (typeof weekdays)[number] {
  const value = new Date(`${date}T12:00:00-05:00`);
  const weekday = weekdays[value.getDay()];
  if (!weekday) throw new Error('Could not resolve fixture weekday');
  return weekday;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00-05:00`);
  value.setDate(value.getDate() + days);
  return localDate(value);
}

test('family books a make-up class and staff records attendance', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const childId = await factories.person(actor, {
      firstName: 'Taylor',
      lastName: 'Gymnast',
      dateOfBirth: '2017-04-12',
    });
    const householdId = await factories.household(actor);
    const program = await factories.program(actor);
    const withOrg = createWithOrg(database);
    await withOrg(actor, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ mode: 'class', status: 'published', visibility: 'public' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: actor.orgId,
          household_id: householdId,
          person_id: childId,
          role: 'athlete',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: actor.orgId,
          person_id: childId,
          account_id: actor.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
    });

    const offerings = new PostgresClassOfferings(database, actor);
    const schedules = new PostgresClassSchedules(database, actor);
    const tomorrow = addDays(localDate(new Date()), 1);
    const endDate = addDays(tomorrow, 45);
    const target = await offerings.create({
      programId: program.programId,
      skillLevelId: null,
      name: 'Make-up Gymnastics',
      description: null,
      ageMinMonths: null,
      ageMaxMonths: null,
      capacity: 8,
      instructorRatio: 8,
      billing: 'monthly',
      priceCents: 12_000,
      punchCardUses: null,
      tuitionTiers: [],
      annualFeeCents: 0,
      trialAllowed: false,
      trialPriceCents: 0,
      makeupPolicy: {
        creditsPerTerm: 2,
        expiryDays: 60,
        eligibleLevelIds: null,
        eligibleOfferingIds: null,
      },
      siblingDiscountBps: [],
      status: 'active',
    });
    const source = await offerings.create({
      programId: program.programId,
      skillLevelId: null,
      name: 'Beginner Gymnastics',
      description: null,
      ageMinMonths: null,
      ageMaxMonths: null,
      capacity: 8,
      instructorRatio: 8,
      billing: 'monthly',
      priceCents: 12_000,
      punchCardUses: null,
      tuitionTiers: [],
      annualFeeCents: 0,
      trialAllowed: false,
      trialPriceCents: 0,
      makeupPolicy: {
        creditsPerTerm: 2,
        expiryDays: 60,
        eligibleLevelIds: null,
        eligibleOfferingIds: [target.id],
      },
      siblingDiscountBps: [],
      status: 'active',
    });

    const today = localDate(new Date());
    const todaySessionTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const todaySessionDate = localDate(todaySessionTime);
    const scheduleInput = (
      startDate: string,
      startTime: string,
      scheduleEndDate = endDate,
    ): Parameters<typeof schedules.create>[1] => ({
      recurrence: {
        kind: 'weekly',
        interval: 1,
        byDay: [localWeekday(startDate)],
        startsOn: startDate,
        endsOn: scheduleEndDate,
        exceptions: [],
        additions: [],
      },
      startTime,
      durationMinutes: 60,
      timezone,
      spaceId: null,
      locationText: 'Main gym',
      termStart: startDate,
      termEnd: scheduleEndDate,
    });
    await schedules.create(
      source.id,
      scheduleInput(todaySessionDate, localTime(todaySessionTime)),
      [],
    );
    await schedules.create(
      target.id,
      scheduleInput(tomorrow, '16:00', tomorrow),
      [],
    );

    await new PostgresClassEnrollments(database, actor).enroll(
      {
        classOfferingId: source.id,
        personId: childId,
        householdId,
        startsOn: today,
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

    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: actor.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    await page.context().addCookies([
      {
        name: '__Host-athlentry_session',
        value: session.token,
        url: String(testInfo.project.use.baseURL),
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    await page.goto(`/console/orgs/${actor.orgId}/classes`);
    await page.getByRole('tab', { name: 'Sessions & attendance' }).click();
    const sourceRow = page.getByRole('row').filter({ hasText: source.name });
    await sourceRow
      .getByRole('button', { name: 'Open roster' })
      .first()
      .click();
    await page
      .getByRole('combobox', { name: 'Attendance for Taylor Gymnast' })
      .selectOption('absent');
    await page
      .getByRole('button', {
        name: 'Save attendance and issue make-up credits',
      })
      .click();
    await expect(page.getByText(/1 make-up credits issued/)).toBeVisible();

    await page.goto(`/me/orgs/${actor.orgId}/classes`);
    await page.getByRole('tab', { name: 'Make-up and bookings' }).click();
    const availableCredit = page.getByLabel('Available credit');
    await expect(availableCredit).toBeVisible();
    await expect(availableCredit.locator('option').nth(1)).toContainText(
      'Beginner Gymnastics',
    );
    await availableCredit.selectOption({ index: 1 });
    const eligibleSession = page.getByLabel('Eligible upcoming session');
    await expect(eligibleSession.locator('option')).toHaveCount(2);
    await eligibleSession.selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Book make-up class' }).click();
    await expect(page.getByText('Make-up class booked.')).toBeVisible();

    await page.goto(`/console/orgs/${actor.orgId}/classes`);
    await page.getByRole('tab', { name: 'Sessions & attendance' }).click();
    const makeUpRow = page.getByRole('row').filter({ hasText: target.name });
    await makeUpRow
      .getByRole('button', { name: 'Open roster' })
      .first()
      .click();
    await expect(page.getByRole('cell', { name: 'makeup' })).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Attendance for Taylor Gymnast' })
      .selectOption('present');
    await page
      .getByRole('button', {
        name: 'Save attendance and issue make-up credits',
      })
      .click();
    await expect(page.getByText(/Attendance saved/)).toBeVisible();
  } finally {
    await database.destroy();
  }
});
