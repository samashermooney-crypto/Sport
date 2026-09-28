import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import type { ActorFixture } from '../server/test/factories';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

// League and club spaces can be outside the viewer's timezone.
test.use({ timezoneId: 'UTC' });

test('two member clubs complete a U12 inter-club season', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const withOrg = createWithOrg(database);
  const factories = createTestFactories(database);
  try {
    const league = await factories.actor();
    const clubA = await factories.actor();
    const clubB = await factories.actor();
    for (const [actor, name] of [
      [league, 'Metro Youth Sports Association'],
      [clubA, 'Riverside Athletic'],
      [clubB, 'Northside Athletic'],
    ] as const) {
      await withOrg(actor, (trx) =>
        trx
          .updateTable('organizations')
          .set({ name })
          .where('id', '=', actor.orgId)
          .execute(),
      );
    }
    const leagueProgram = await factories.program(league);
    await withOrg(league, (trx) =>
      Promise.all([
        trx
          .updateTable('divisions')
          .set({ age_label: 'U12' })
          .where('id', '=', leagueProgram.divisionId)
          .execute(),
        trx
          .updateTable('registration_offerings')
          .set({ registrant_role: 'team_entry', active: true })
          .where('id', '=', leagueProgram.offeringId)
          .execute(),
      ]).then(() => undefined),
    );

    const teamA = await seedClubTeam(
      clubA,
      'Riverside U12',
      factories,
      withOrg,
    );
    const teamB = await seedClubTeam(
      clubB,
      'Northside U12',
      factories,
      withOrg,
    );
    await seedSpace(clubA, 'Riverside Field', withOrg);
    await seedSpace(clubB, 'Northside Field', withOrg);

    await loginAs(
      page,
      testInfo.project.use.baseURL,
      database,
      withOrg,
      league,
    );
    await page.goto(`/console/federation/${league.orgId}`);
    await expect(
      page.getByRole('heading', { name: 'League and association' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'Relationships' }).click();
    await inviteClub(page, await slugFor(clubA, withOrg), 'Riverside Athletic');
    await inviteClub(page, await slugFor(clubB, withOrg), 'Northside Athletic');

    for (const club of [clubA, clubB]) {
      await loginAs(
        page,
        testInfo.project.use.baseURL,
        database,
        withOrg,
        club,
      );
      await page.goto(`/console/federation/${club.orgId}`);
      await page.getByRole('button', { name: 'Relationships' }).click();
      await page.getByRole('button', { name: 'Accept', exact: true }).click();
      await expect(
        page.getByText('active', { exact: true }).first(),
      ).toBeVisible();
    }

    await submitClubTeam(
      page,
      testInfo.project.use.baseURL,
      database,
      withOrg,
      clubA,
      league,
      teamA,
      'Riverside U12',
    );
    await submitClubTeam(
      page,
      testInfo.project.use.baseURL,
      database,
      withOrg,
      clubB,
      league,
      teamB,
      'Northside U12',
    );

    await loginAs(
      page,
      testInfo.project.use.baseURL,
      database,
      withOrg,
      league,
    );
    await page.goto(`/console/federation/${league.orgId}`);
    await page.getByRole('button', { name: 'Competition' }).click();
    await expect(page.getByText('League entries to review')).toBeVisible();
    await page
      .getByRole('button', { name: 'Accept', exact: true })
      .nth(0)
      .click();
    await page
      .getByRole('button', { name: 'Accept', exact: true })
      .nth(0)
      .click();

    for (const [club, fieldName] of [
      [clubA, 'Riverside Field'],
      [clubB, 'Northside Field'],
    ] as const) {
      await loginAs(
        page,
        testInfo.project.use.baseURL,
        database,
        withOrg,
        club,
      );
      await page.goto(`/console/federation/${club.orgId}`);
      await page.getByRole('button', { name: 'Competition' }).click();
      await page
        .getByLabel('Offer field windows to a league')
        .selectOption({ label: 'Metro Youth Sports Association' });
      await page
        .getByLabel('Field or court')
        .selectOption({ label: `${fieldName} · ${fieldName} Facility` });
      await expect(
        page.getByText('Availability times use America/Chicago.'),
      ).toBeVisible();
      await page.getByLabel('Available from').fill('2026-10-10T09:00');
      await page.getByLabel('Available until').fill('2026-10-10T10:30');
      await page.getByRole('button', { name: 'Offer availability' }).click();
      await expect(
        page.getByText('Availability offered to the league.'),
      ).toBeVisible();
    }

    await loginAs(
      page,
      testInfo.project.use.baseURL,
      database,
      withOrg,
      league,
    );
    await page.goto(`/console/federation/${league.orgId}`);
    await page.getByRole('button', { name: 'Competition' }).click();
    await page
      .getByLabel('League program')
      .first()
      .selectOption(leagueProgram.programId);
    await page.getByRole('button', { name: 'Generate schedule draft' }).click();
    await expect(
      page.getByText(
        'Schedule draft generated from league and member-club availability.',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/1 games · 0 unscheduled/)).toBeVisible();
    await page.getByRole('button', { name: 'Apply schedule' }).click();
    await expect(
      page.getByText('Schedule applied to league and home-club calendars.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Publish schedule' }).click();
    await expect(page.getByText('Schedule published.')).toBeVisible();

    const eventLink = await withOrg(league, (trx) =>
      trx
        .selectFrom('federation_event_links')
        .select(['club_org_id'])
        .where('league_org_id', '=', league.orgId)
        .where('status', '=', 'active')
        .executeTakeFirstOrThrow(),
    );
    const host = eventLink.club_org_id === clubA.orgId ? clubA : clubB;
    await loginAs(page, testInfo.project.use.baseURL, database, withOrg, host);
    await page.goto(`/console/federation/${host.orgId}`);
    await page.getByRole('button', { name: 'Competition' }).click();
    await page
      .getByRole('combobox', { name: 'League', exact: true })
      .last()
      .selectOption({ label: 'Metro Youth Sports Association' });
    const hostProgram = page.getByRole('combobox', {
      name: 'Your league program',
      exact: true,
    });
    await hostProgram.selectOption('');
    await hostProgram.selectOption({ label: 'Fixture League' });
    await expect(
      page.getByRole('heading', { name: 'Open standings' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Enter home result' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Enter home result' }).click();
    await page.getByLabel('Home team').selectOption({ label: 'Riverside U12' });
    await page.getByLabel('Home score').fill('2');
    await page.getByLabel('Away team').selectOption({ label: 'Northside U12' });
    await page.getByLabel('Away score').fill('1');
    await page.getByRole('button', { name: 'Submit result' }).click();
    await expect(
      page.getByText('Hosted game result submitted to the league.'),
    ).toBeVisible();

    await loginAs(
      page,
      testInfo.project.use.baseURL,
      database,
      withOrg,
      league,
    );
    await page.goto(`/console/federation/${league.orgId}`);
    await page.getByRole('button', { name: 'Competition' }).click();
    const leagueProgramPicker = page
      .getByRole('combobox', {
        name: 'League program',
        exact: true,
      })
      .first();
    await leagueProgramPicker.selectOption('');
    await leagueProgramPicker.selectOption(leagueProgram.programId);
    await expect(
      page.getByRole('heading', { name: 'Open standings' }),
    ).toBeVisible();
    await expect(
      page.getByRole('rowheader', { name: 'Riverside U12', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('rowheader', { name: 'Northside U12', exact: true }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    const nonHost = host.orgId === clubA.orgId ? clubB : clubA;
    await loginAs(
      page,
      testInfo.project.use.baseURL,
      database,
      withOrg,
      nonHost,
    );
    await page.goto(`/console/federation/${nonHost.orgId}`);
    await page.getByRole('button', { name: 'Competition' }).click();
    await page
      .getByRole('combobox', { name: 'League', exact: true })
      .last()
      .selectOption({ label: 'Metro Youth Sports Association' });
    const nonHostProgram = page.getByRole('combobox', {
      name: 'Your league program',
      exact: true,
    });
    await nonHostProgram.selectOption('');
    await nonHostProgram.selectOption({ label: 'Fixture League' });
    await expect(
      page.getByRole('rowheader', { name: 'Riverside U12', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('rowheader', { name: 'Northside U12', exact: true }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});

async function seedClubTeam(
  club: ActorFixture,
  teamName: string,
  factories: ReturnType<typeof createTestFactories>,
  withOrg: ReturnType<typeof createWithOrg>,
): Promise<{ teamSeasonId: string }> {
  const program = await factories.program(club);
  const team = await factories.team(club, program);
  await withOrg(club, async (trx) => {
    await trx
      .updateTable('teams')
      .set({ name: teamName })
      .where('id', '=', team.teamId)
      .execute();
    await trx
      .updateTable('team_seasons')
      .set({ display_name: teamName })
      .where('id', '=', team.teamSeasonId)
      .execute();
  });
  const personId = await factories.person(club, { firstName: teamName });
  await withOrg(club, (trx) =>
    trx
      .insertInto('roster_entries')
      .values({
        id: newId(),
        org_id: club.orgId,
        team_season_id: team.teamSeasonId,
        person_id: personId,
        status: 'active',
      })
      .execute(),
  );
  return { teamSeasonId: team.teamSeasonId };
}

async function seedSpace(
  actor: ActorFixture,
  name: string,
  withOrg: ReturnType<typeof createWithOrg>,
): Promise<void> {
  const facilityId = newId();
  const spaceId = newId();
  await withOrg(actor, async (trx) => {
    await trx
      .insertInto('facilities')
      .values({
        id: facilityId,
        org_id: actor.orgId,
        name: `${name} Facility`,
        ownership: 'owned',
      })
      .execute();
    await trx
      .insertInto('spaces')
      .values({
        id: spaceId,
        org_id: actor.orgId,
        facility_id: facilityId,
        name,
        kind: 'field',
      })
      .execute();
  });
}

async function slugFor(
  actor: ActorFixture,
  withOrg: ReturnType<typeof createWithOrg>,
): Promise<string> {
  return withOrg(actor, async (trx) => {
    const row = await trx
      .selectFrom('organizations')
      .select('slug')
      .where('id', '=', actor.orgId)
      .executeTakeFirstOrThrow();
    return row.slug;
  });
}

async function loginAs(
  page: import('@playwright/test').Page,
  baseUrl: string | undefined,
  database: ReturnType<typeof createDatabase>,
  withOrg: ReturnType<typeof createWithOrg>,
  actor: ActorFixture,
): Promise<void> {
  if (!baseUrl) throw new Error('Playwright baseURL is required');
  await withOrg(actor, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .where('account_id', '=', actor.accountId)
      .execute(),
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
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: '__Host-athlentry_session',
      value: session.token,
      url: baseUrl,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

async function inviteClub(
  page: import('@playwright/test').Page,
  slug: string,
  clubName: string,
): Promise<void> {
  await page.getByLabel('Name, organization slug, or owner email').fill(slug);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const proposedAgreement = page.getByRole('group', {
    name: 'Proposed data-sharing agreement',
  });
  await proposedAgreement
    .getByRole('checkbox', { name: 'Submitted rosters' })
    .check();
  await proposedAgreement
    .getByRole('checkbox', { name: 'Staff compliance status' })
    .check();
  await proposedAgreement
    .getByRole('checkbox', { name: 'Team entry information' })
    .check();
  await proposedAgreement
    .getByRole('checkbox', { name: 'Federation discipline' })
    .check();
  await page.getByRole('button', { name: 'Send relationship request' }).click();
  await expect(page.getByText('Relationship request sent.')).toBeVisible();
  await expect(page.getByText(clubName, { exact: true })).toBeVisible();
}

async function submitClubTeam(
  page: import('@playwright/test').Page,
  baseUrl: string | undefined,
  database: ReturnType<typeof createDatabase>,
  withOrg: ReturnType<typeof createWithOrg>,
  club: ActorFixture,
  league: ActorFixture,
  team: { teamSeasonId: string },
  teamName: string,
): Promise<void> {
  await loginAs(page, baseUrl, database, withOrg, club);
  await page.goto(`/console/federation/${club.orgId}`);
  await page.getByRole('button', { name: 'Competition' }).click();
  await page
    .getByRole('combobox', { name: 'League', exact: true })
    .first()
    .selectOption(league.orgId);
  await page.getByLabel('Team season').selectOption(team.teamSeasonId);
  const leagueProgramSelect = page.getByRole('combobox', {
    name: 'League program',
    exact: true,
  });
  await expect(leagueProgramSelect).toContainText('Fixture League');
  await leagueProgramSelect.selectOption({ label: 'Fixture League' });
  await page
    .getByRole('combobox', { name: 'Division', exact: true })
    .selectOption({ label: 'Open · U12' });
  await page.getByRole('button', { name: 'Submit team' }).click();
  await expect(
    page.getByText('Team entry submitted with a roster snapshot.'),
  ).toBeVisible();
  await expect(page.getByText(teamName, { exact: true })).toBeVisible();
}
