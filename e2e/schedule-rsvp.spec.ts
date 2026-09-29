import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('guardian RSVPs an athlete to a team event', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const team = await factories.team(actor, program);
    const personId = await factories.person(actor, {
      firstName: 'Casey',
      lastName: 'Player',
      dateOfBirth: '2012-04-03',
    });
    const householdId = await factories.household(actor);
    const eventId = newId();
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    await createWithOrg(database)(actor, async (trx) => {
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
          person_id: personId,
          role: 'athlete',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: actor.orgId,
          person_id: personId,
          account_id: actor.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('roster_entries')
        .values({
          id: newId(),
          org_id: actor.orgId,
          team_season_id: team.teamSeasonId,
          person_id: personId,
          status: 'active',
        })
        .execute();
      await trx
        .insertInto('events')
        .values({
          id: eventId,
          org_id: actor.orgId,
          program_id: program.programId,
          division_id: program.divisionId,
          kind: 'game',
          title: 'Family RSVP game',
          starts_at: startsAt,
          ends_at: endsAt,
          timezone: 'America/Chicago',
          published: true,
        })
        .execute();
      await trx
        .insertInto('event_participants')
        .values({
          id: newId(),
          org_id: actor.orgId,
          event_id: eventId,
          team_season_id: team.teamSeasonId,
          side: 'home',
        })
        .execute();
    });
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
    const baseURL = String(testInfo.project.use.baseURL);
    await page.context().addCookies([
      {
        name: '__Host-athlentry_session',
        value: session.token,
        url: baseURL,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    await page.goto(
      `/portal/orgs/${actor.orgId}/schedule/teams/${team.teamSeasonId}/people/${personId}`,
    );
    await expect(page.locator('.ui-app-shell')).toHaveCount(1);
    await expect(
      page.getByRole('heading', { name: 'Upcoming events' }),
    ).toBeVisible();
    await expect(page.getByText('Family RSVP game')).toBeVisible();
    const going = page.getByRole('button', { name: 'Going' });
    await going.click();
    await expect(page.getByRole('status')).toHaveText('Your RSVP is saved.');
    await expect(going).toHaveAttribute('aria-pressed', 'true');
    const savedRsvp = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('attendance')
        .select(['rsvp', 'rsvp_by_account_id'])
        .where('org_id', '=', actor.orgId)
        .where('event_id', '=', eventId)
        .where('person_id', '=', personId)
        .executeTakeFirstOrThrow(),
    );
    expect(savedRsvp).toEqual({
      rsvp: 'yes',
      rsvp_by_account_id: actor.accountId,
    });
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
