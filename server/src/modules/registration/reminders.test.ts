import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import { createWithOrg } from '../../db/withOrg.js';

import { enqueueRegistrationReminders } from './reminders.js';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

describe('registration reminder scheduling', () => {
  it('queues due checkout and waitlist reminders once and leaves future rows untouched', async () => {
    const orgId = newId();
    const accountId = newId();
    const checkoutId = newId();
    const recentCheckoutId = newId();
    const completedCheckoutId = newId();
    const waitlistId = newId();
    const profileId = newId();
    const seasonId = newId();
    const programId = newId();
    const offeringId = newId();
    const personId = newId();
    const householdId = newId();

    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `registration-reminder-${randomUUID()}@example.invalid`,
        first_name: 'Family',
        last_name: 'One',
        date_of_birth: '1990-01-01',
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `registration-reminder-${randomUUID().slice(0, 10)}`,
        name: 'Registration reminder test',
        kind: 'club',
        timezone: 'America/Chicago',
      })
      .execute();

    const context = { orgId, actor: { accountId } };
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('sport_profiles')
        .values({ id: profileId, org_id: orgId, name: 'Soccer', profile: {} })
        .execute();
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: 'Reminder test season',
          starts_on: '2026-09-01',
          ends_on: '2026-12-01',
          status: 'active',
        })
        .execute();
      await trx
        .insertInto('programs')
        .values({
          id: programId,
          org_id: orgId,
          season_id: seasonId,
          sport_profile_id: profileId,
          mode: 'league',
          name: 'Reminder test program',
          slug: `reminders-${randomUUID().slice(0, 8)}`,
          starts_on: '2026-09-01',
          ends_on: '2026-12-01',
        })
        .execute();
      await trx
        .insertInto('registration_offerings')
        .values({
          id: offeringId,
          org_id: orgId,
          program_id: programId,
          name: 'Reminder test offering',
          registrant_role: 'athlete',
          active: true,
          waitlist_enabled: true,
        })
        .execute();
      await trx
        .insertInto('people')
        .values({
          id: personId,
          org_id: orgId,
          first_name: 'Maya',
          last_name: 'One',
          date_of_birth: '2012-05-01',
        })
        .execute();
      await trx
        .insertInto('households')
        .values({ id: householdId, org_id: orgId, name: 'Reminder household' })
        .execute();
      await trx
        .insertInto('checkouts')
        .values([
          {
            id: checkoutId,
            org_id: orgId,
            account_id: accountId,
            status: 'awaiting_payment',
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
            pricing_snapshot: {},
          },
          {
            id: recentCheckoutId,
            org_id: orgId,
            account_id: accountId,
            status: 'awaiting_payment',
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            created_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
            pricing_snapshot: {},
          },
          {
            id: completedCheckoutId,
            org_id: orgId,
            account_id: accountId,
            status: 'completed',
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
            pricing_snapshot: {},
          },
        ])
        .execute();
      await trx
        .insertInto('waitlist_entries')
        .values({
          id: waitlistId,
          org_id: orgId,
          offering_id: offeringId,
          person_id: personId,
          household_id: householdId,
          position: 1,
          status: 'offered',
          offered_at: new Date(),
          offer_expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000),
          checkout_id: checkoutId,
        })
        .execute();
    });

    const dependencies = { database, organizationIds: [orgId] };
    expect(await enqueueRegistrationReminders(dependencies)).toBe(2);
    expect(await enqueueRegistrationReminders(dependencies)).toBe(0);

    const rows = await createWithOrg(database)(context, async (trx) => ({
      checkouts: await trx
        .selectFrom('checkouts')
        .select(['id', 'reminder_sent_at'])
        .where('org_id', '=', orgId)
        .where('id', 'in', [checkoutId, recentCheckoutId, completedCheckoutId])
        .execute(),
      offers: await trx
        .selectFrom('waitlist_entries')
        .select(['id', 'expiring_notified_at'])
        .where('org_id', '=', orgId)
        .where('id', '=', waitlistId)
        .execute(),
      notices: await trx
        .selectFrom('registration_notice_outbox')
        .select('kind')
        .where('org_id', '=', orgId)
        .orderBy('kind')
        .execute(),
    }));
    expect(
      rows.checkouts.find(({ id }) => id === checkoutId)?.reminder_sent_at,
    ).not.toBeNull();
    expect(
      rows.checkouts.find(({ id }) => id === recentCheckoutId)
        ?.reminder_sent_at,
    ).toBeNull();
    expect(
      rows.checkouts.find(({ id }) => id === completedCheckoutId)
        ?.reminder_sent_at,
    ).toBeNull();
    expect(rows.offers[0]?.expiring_notified_at).not.toBeNull();
    expect(rows.notices.map(({ kind }) => kind)).toEqual([
      'checkout_reminder',
      'waitlist_offer_expiring',
    ]);
  });

  it('expires stale offers, releases their holds, and advances the waitlist once', async () => {
    const orgId = newId();
    const accountId = newId();
    const seasonId = newId();
    const profileId = newId();
    const programId = newId();
    const offeringId = newId();
    const stalePersonId = newId();
    const waitingPersonId = newId();
    const householdId = newId();
    const staleCheckoutId = newId();
    const staleEntryId = newId();
    const waitingEntryId = newId();
    const staleExpiresAt = new Date(Date.now() - 60_000);

    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `registration-waitlist-${randomUUID()}@example.invalid`,
        first_name: 'Family',
        last_name: 'Two',
        date_of_birth: '1990-01-01',
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `waitlist-expiry-${randomUUID().slice(0, 10)}`,
        name: 'Waitlist expiry test',
        kind: 'club',
        timezone: 'America/Chicago',
      })
      .execute();

    const context = { orgId, actor: { accountId } };
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('sport_profiles')
        .values({ id: profileId, org_id: orgId, name: 'Soccer', profile: {} })
        .execute();
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: 'Waitlist expiry season',
          starts_on: '2026-09-01',
          ends_on: '2026-12-01',
          status: 'active',
        })
        .execute();
      await trx
        .insertInto('programs')
        .values({
          id: programId,
          org_id: orgId,
          season_id: seasonId,
          sport_profile_id: profileId,
          mode: 'league',
          name: 'Waitlist expiry program',
          slug: `waitlist-${randomUUID().slice(0, 8)}`,
          starts_on: '2026-09-01',
          ends_on: '2026-12-01',
          settings: {},
        })
        .execute();
      await trx
        .insertInto('registration_offerings')
        .values({
          id: offeringId,
          org_id: orgId,
          program_id: programId,
          name: 'Waitlist expiry offering',
          registrant_role: 'athlete',
          active: true,
          waitlist_enabled: true,
          capacity: 1,
        })
        .execute();
      await trx
        .insertInto('people')
        .values([
          {
            id: stalePersonId,
            org_id: orgId,
            first_name: 'Maya',
            last_name: 'Stale',
            date_of_birth: '2012-05-01',
          },
          {
            id: waitingPersonId,
            org_id: orgId,
            first_name: 'Maya',
            last_name: 'Waiting',
            date_of_birth: '2012-06-01',
          },
        ])
        .execute();
      await trx
        .insertInto('households')
        .values({ id: householdId, org_id: orgId, name: 'Waitlist family' })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: orgId,
          person_id: waitingPersonId,
          account_id: accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('checkouts')
        .values({
          id: staleCheckoutId,
          org_id: orgId,
          account_id: accountId,
          status: 'open',
          expires_at: staleExpiresAt,
          items: [],
        })
        .execute();
      await trx
        .insertInto('capacity_counters')
        .values({
          id: newId(),
          org_id: orgId,
          subject_type: 'offering',
          subject_id: offeringId,
          capacity: 1,
          held: 1,
        })
        .execute();
      await trx
        .insertInto('capacity_holds')
        .values({
          id: newId(),
          org_id: orgId,
          checkout_id: staleCheckoutId,
          subject_type: 'offering',
          subject_id: offeringId,
          quantity: 1,
          expires_at: staleExpiresAt,
        })
        .execute();
      await trx
        .insertInto('waitlist_entries')
        .values([
          {
            id: staleEntryId,
            org_id: orgId,
            offering_id: offeringId,
            person_id: stalePersonId,
            household_id: householdId,
            position: 1,
            status: 'offered',
            offered_at: staleExpiresAt,
            offer_expires_at: staleExpiresAt,
            checkout_id: staleCheckoutId,
          },
          {
            id: waitingEntryId,
            org_id: orgId,
            offering_id: offeringId,
            person_id: waitingPersonId,
            household_id: householdId,
            position: 2,
            status: 'waiting',
          },
        ])
        .execute();
    });

    const dependencies = { database, organizationIds: [orgId] };
    expect(await enqueueRegistrationReminders(dependencies)).toBe(0);
    expect(await enqueueRegistrationReminders(dependencies)).toBe(0);

    const result = await createWithOrg(database)(context, async (trx) => ({
      entries: await trx
        .selectFrom('waitlist_entries')
        .select(['id', 'status', 'checkout_id'])
        .where('org_id', '=', orgId)
        .orderBy('position')
        .execute(),
      checkouts: await trx
        .selectFrom('checkouts')
        .select(['id', 'status'])
        .where('org_id', '=', orgId)
        .execute(),
      holds: await trx
        .selectFrom('capacity_holds')
        .select(['checkout_id', 'released_at'])
        .where('org_id', '=', orgId)
        .execute(),
      counter: await trx
        .selectFrom('capacity_counters')
        .select('held')
        .where('org_id', '=', orgId)
        .where('subject_type', '=', 'offering')
        .where('subject_id', '=', offeringId)
        .executeTakeFirstOrThrow(),
      notices: await trx
        .selectFrom('registration_notice_outbox')
        .select('kind')
        .where('org_id', '=', orgId)
        .execute(),
    }));
    const waiting = result.entries.find(({ id }) => id === waitingEntryId);
    expect(result.entries.find(({ id }) => id === staleEntryId)?.status).toBe(
      'expired',
    );
    expect(waiting?.status).toBe('offered');
    expect(waiting?.checkout_id).not.toBeNull();
    expect(
      result.checkouts.find(({ id }) => id === staleCheckoutId)?.status,
    ).toBe('expired');
    expect(
      result.checkouts.find(({ id }) => id === waiting?.checkout_id)?.status,
    ).toBe('open');
    expect(
      result.holds.find(({ checkout_id }) => checkout_id === staleCheckoutId)
        ?.released_at,
    ).not.toBeNull();
    expect(
      result.holds.find(
        ({ checkout_id }) => checkout_id === waiting?.checkout_id,
      )?.released_at,
    ).toBeNull();
    expect(result.counter.held).toBe(1);
    expect(result.notices.map(({ kind }) => kind)).toEqual(['waitlist_offer']);
  });
});
