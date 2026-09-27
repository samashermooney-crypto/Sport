import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test.fixme('QA-SEC-014 / Track I: only the assigned instructor account may read its session roster', async ({
  request,
}) => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );

  try {
    const factories = createTestFactories(database);
    const organization = await factories.actor();
    const program = await factories.program(organization);
    const instructorPersonId = await factories.person(organization, {
      firstName: 'Adult',
      lastName: 'Instructor',
      dateOfBirth: '1980-05-01',
    });
    const studentPersonId = await factories.person(organization, {
      firstName: 'Private',
      lastName: 'Student',
    });
    const householdId = await factories.household(organization);
    const guardianAccountId = newId();
    const offeringId = newId();
    const scheduleId = newId();
    const eventId = newId();
    const sessionId = newId();
    const bookingId = newId();
    const withOrg = createWithOrg(database);
    const startsAt = new Date(Date.now() + 86_400_000);

    await database
      .insertInto('accounts')
      .values({
        id: guardianAccountId,
        email: `qa-instructor-guardian-${newId()}@example.invalid`,
        first_name: 'Instructor',
        last_name: 'Guardian',
        date_of_birth: '1960-01-01',
        email_verified_at: new Date(),
      })
      .execute();

    await withOrg(organization, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ mode: 'class', status: 'published', visibility: 'public' })
        .where('org_id', '=', organization.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: organization.orgId,
          person_id: instructorPersonId,
          account_id: guardianAccountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('class_offerings')
        .values({
          id: offeringId,
          org_id: organization.orgId,
          program_id: program.programId,
          name: 'Roster privacy class',
          capacity: 8,
          instructor_ratio: '8',
          billing: 'drop_in',
          price_cents: 0,
        })
        .execute();
      await trx
        .insertInto('class_schedules')
        .values({
          id: scheduleId,
          org_id: organization.orgId,
          class_offering_id: offeringId,
          recurrence: { kind: 'once', date: '2026-10-01' },
          start_time: '12:00',
          duration_minutes: 60,
          timezone: 'America/Chicago',
          term_start: '2026-09-01',
          term_end: '2026-12-31',
        })
        .execute();
      await trx
        .insertInto('class_instructors')
        .values({
          id: newId(),
          org_id: organization.orgId,
          class_schedule_id: scheduleId,
          person_id: instructorPersonId,
          status: 'active',
          added_by: organization.accountId,
        })
        .execute();
      await trx
        .insertInto('events')
        .values({
          id: eventId,
          org_id: organization.orgId,
          program_id: program.programId,
          kind: 'class_session',
          title: 'Roster privacy session',
          starts_at: startsAt,
          ends_at: new Date(startsAt.getTime() + 3_600_000),
          timezone: 'America/Chicago',
          status: 'scheduled',
        })
        .execute();
      await trx
        .insertInto('class_sessions')
        .values({
          id: sessionId,
          org_id: organization.orgId,
          event_id: eventId,
          class_offering_id: offeringId,
          class_schedule_id: scheduleId,
          capacity: 8,
        })
        .execute();
      await trx
        .insertInto('class_session_bookings')
        .values({
          id: bookingId,
          org_id: organization.orgId,
          class_session_id: sessionId,
          person_id: studentPersonId,
          household_id: householdId,
          account_id: organization.accountId,
          kind: 'drop_in',
          status: 'booked',
        })
        .execute();
    });

    const guardianSession = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: guardianAccountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    const response = await request.get(
      `http://127.0.0.1:${String(3001 + offset)}/api/v1/classes/orgs/${organization.orgId}/sessions/${sessionId}/roster`,
      {
        headers: {
          Cookie: `__Host-athlentry_session=${guardianSession.token}`,
        },
      },
    );

    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain('Private Student');
  } finally {
    await database.destroy();
  }
});
