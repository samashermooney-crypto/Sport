import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test.fixme('QA-SEC-011 / Track I: class portal actions require a current guardian link and record owner', async ({
  request,
}) => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const guardian = await factories.actor();
    const childId = await factories.person(guardian, {
      firstName: 'Class',
      lastName: 'Private Child',
      dateOfBirth: '2016-09-12',
    });
    const householdId = await factories.household(guardian);
    const program = await factories.program(guardian);
    const offeringId = newId();
    const scheduleId = newId();
    const bookingId = newId();
    const cardId = newId();
    const withOrg = createWithOrg(database);

    const memberAccountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: memberAccountId,
        email: `qa-class-member-${newId()}@example.invalid`,
        first_name: 'Unrelated',
        last_name: 'Member',
        date_of_birth: '1990-01-01',
        email_verified_at: new Date(),
      })
      .execute();

    const sessionIds = [newId(), newId()];
    const eventIds = [newId(), newId()];
    const startsAt = [
      new Date(Date.now() + 86_400_000),
      new Date(Date.now() + 172_800_000),
    ];
    const invoiceId = await factories.invoice(guardian, 9001);

    await withOrg(guardian, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ mode: 'class', status: 'published', visibility: 'public' })
        .where('org_id', '=', guardian.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: guardian.orgId,
          household_id: householdId,
          person_id: childId,
          role: 'athlete',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: guardian.orgId,
          person_id: childId,
          account_id: guardian.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: guardian.orgId,
          account_id: memberAccountId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('class_offerings')
        .values({
          id: offeringId,
          org_id: guardian.orgId,
          program_id: program.programId,
          name: 'Private punch-card class',
          capacity: 8,
          instructor_ratio: '8',
          billing: 'punch_card',
          price_cents: 0,
          punch_card_uses: 3,
        })
        .execute();
      await trx
        .insertInto('class_schedules')
        .values({
          id: scheduleId,
          org_id: guardian.orgId,
          class_offering_id: offeringId,
          recurrence: { kind: 'once', date: '2026-10-01' },
          start_time: '12:00',
          duration_minutes: 60,
          timezone: 'America/Chicago',
          term_start: '2026-09-01',
          term_end: '2026-12-31',
        })
        .execute();
      for (let index = 0; index < sessionIds.length; index += 1) {
        const eventId = eventIds[index];
        const sessionId = sessionIds[index];
        const starts = startsAt[index];
        if (!eventId || !sessionId || !starts)
          throw new Error('Missing class session fixture value');
        await trx
          .insertInto('events')
          .values({
            id: eventId,
            org_id: guardian.orgId,
            program_id: program.programId,
            kind: 'class_session',
            title: 'Private class session',
            starts_at: starts,
            ends_at: new Date(starts.getTime() + 3_600_000),
            timezone: 'America/Chicago',
            status: 'scheduled',
          })
          .execute();
        await trx
          .insertInto('class_sessions')
          .values({
            id: sessionId,
            org_id: guardian.orgId,
            event_id: eventId,
            class_offering_id: offeringId,
            class_schedule_id: scheduleId,
            capacity: 8,
          })
          .execute();
      }
      await trx
        .insertInto('class_session_bookings')
        .values({
          id: bookingId,
          org_id: guardian.orgId,
          class_session_id: sessionIds[0] ?? '',
          person_id: childId,
          household_id: householdId,
          account_id: guardian.accountId,
          kind: 'drop_in',
          status: 'booked',
        })
        .execute();
      await trx
        .insertInto('punch_cards')
        .values({
          id: cardId,
          org_id: guardian.orgId,
          account_id: guardian.accountId,
          household_id: householdId,
          person_id: childId,
          class_offering_id: offeringId,
          total_uses: 3,
          remaining_uses: 3,
          invoice_id: invoiceId,
          status: 'active',
        })
        .execute();
      await trx
        .updateTable('person_account_links')
        .set({ revoked_at: new Date() })
        .where('org_id', '=', guardian.orgId)
        .where('person_id', '=', childId)
        .where('account_id', '=', guardian.accountId)
        .execute();
    });

    const memberSession = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: memberAccountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    const guardianSession = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: guardian.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    const apiBase = `http://127.0.0.1:${String(3001 + offset)}/api/v1/classes/orgs/${guardian.orgId}/me`;
    const writeHeaders = {
      Origin: `https://127.0.0.1:${String(5173 + offset)}`,
      'X-Athlentry-Request': '1',
    };
    const cardListResponse = await request.get(`${apiBase}/punch-cards`, {
      headers: {
        Cookie: `__Host-athlentry_session=${guardianSession.token}`,
      },
    });
    const cancelResponse = await request.post(
      `${apiBase}/bookings/${bookingId}/cancel`,
      {
        headers: {
          ...writeHeaders,
          Cookie: `__Host-athlentry_session=${memberSession.token}`,
        },
      },
    );
    const redeemResponse = await request.post(
      `${apiBase}/punch-cards/${cardId}/book`,
      {
        headers: {
          ...writeHeaders,
          Cookie: `__Host-athlentry_session=${memberSession.token}`,
        },
        data: { classSessionId: sessionIds[1] },
      },
    );

    expect(cardListResponse.status()).toBe(200);
    const cardPayload = (await cardListResponse.json()) as {
      items: Array<{ personName: string; id: string }>;
    };
    expect(cardPayload.items).toEqual([]);
    expect(JSON.stringify(cardPayload)).not.toContain('Private Child');
    expect(cancelResponse.status()).toBe(404);
    expect(redeemResponse.status()).toBe(404);
    const booking = await database
      .selectFrom('class_session_bookings')
      .select('status')
      .where('org_id', '=', guardian.orgId)
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow();
    const card = await database
      .selectFrom('punch_cards')
      .select('remaining_uses')
      .where('org_id', '=', guardian.orgId)
      .where('id', '=', cardId)
      .executeTakeFirstOrThrow();
    expect(booking.status).toBe('booked');
    expect(card.remaining_uses).toBe(3);
  } finally {
    await database.destroy();
  }
});
