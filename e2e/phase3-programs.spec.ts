import { randomUUID } from 'node:crypto';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import {
  createTestFactories,
  type ActorFixture,
} from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

async function signInAsOwner(
  page: Page,
  testInfo: TestInfo,
  database: ReturnType<typeof createDatabase>,
  actor: ActorFixture,
): Promise<void> {
  await createWithOrg(database)(actor, (trx) =>
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
        privileged: true,
        mfaVerifiedAt: new Date(),
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
}

test('staff creates a volleyball season program, divisions, and generated teams', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const actor = await createTestFactories(database).actor();
    await signInAsOwner(page, testInfo, database, actor);
    await page.goto(`/console/orgs/${actor.orgId}/programs`);
    await expect(
      page.getByRole('heading', { name: 'Seasons and programs' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    await page.getByLabel('Season name').fill('Fall 2026');
    await page.getByLabel('Starts').first().fill('2026-08-01');
    await page.getByLabel('Ends').first().fill('2026-12-01');
    await page.getByRole('button', { name: 'Create season' }).click();
    await expect(page.getByRole('status')).toHaveText('Created Fall 2026');

    await page.getByLabel('Built-in template').selectOption('volleyball');
    await page.getByRole('button', { name: 'Add sport profile' }).click();
    await expect(page.getByText(/Volleyball · version/)).toBeVisible();
    await page.getByLabel('Program name').fill('Junior Volleyball');
    await page.getByLabel('Starts').last().fill('2026-08-15');
    await page.getByLabel('Ends').last().fill('2026-11-15');
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByLabel('Division method').selectOption('birth_year');
    await page.getByLabel('From').fill('10');
    await page.getByLabel('To').fill('12');
    await page.getByRole('checkbox', { name: 'Coed' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByLabel('Price ($)').fill('125');
    await page.getByLabel('Capacity').fill('24');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText(/Junior Volleyball · club ·/)).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Create and publish' }).click();
    await expect(
      page.getByRole('status').filter({
        hasText:
          /Junior Volleyball is published with 9 divisions and 1 offerings/,
      }),
    ).toBeVisible();

    const manage = page.getByRole('button', { name: 'Manage' });
    if (await manage.isVisible()) await manage.click();
    await page.getByRole('link', { name: 'Teams' }).click();
    await expect(
      page.getByRole('heading', { name: 'Team seasons and rosters' }),
    ).toBeVisible();
    const divisionPicker = page.getByLabel('Division').nth(1);
    await expect(divisionPicker.locator('option')).toHaveCount(10);
    await page.getByLabel('Number of teams').fill('3');
    await page.getByLabel('Naming pattern').fill('Volley {n}');
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Generate teams' }).click();
    await expect(page.getByRole('status')).toHaveText('Created 3 teams');
    expect(await accessibilityViolations(page)).toEqual([]);

    const program = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('programs')
        .select(['id', 'status', 'season_id'])
        .where('org_id', '=', actor.orgId)
        .where('slug', '=', 'junior-volleyball')
        .executeTakeFirstOrThrow(),
    );
    expect(program.status).toBe('published');
    const divisions = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('divisions')
        .select(['name', 'age_label', 'competition_gender'])
        .where('org_id', '=', actor.orgId)
        .where('program_id', '=', program.id)
        .execute(),
    );
    expect(divisions).toHaveLength(9);
    expect(divisions.map((division) => division.name)).toContain('U12 Girls');
    const generatedTeams = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('team_seasons as seasons')
        .innerJoin('teams', 'teams.id', 'seasons.team_id')
        .select('teams.name')
        .where('seasons.org_id', '=', actor.orgId)
        .where('seasons.program_id', '=', program.id)
        .execute(),
    );
    expect(generatedTeams.map((team) => team.name).sort()).toEqual([
      'Volley 1',
      'Volley 2',
      'Volley 3',
    ]);
  } finally {
    await database.destroy();
  }
});

test('staff previews and commits a season rollover with selected teams and staff', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const source = await factories.program(actor);
    const team = await factories.team(actor, source);
    const coachPersonId = await factories.person(actor, {
      firstName: 'Jordan',
      lastName: 'Coach',
    });
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('seasons')
        .set({
          name: 'Fall 2026',
          starts_on: '2026-01-01',
          ends_on: '2026-12-31',
        })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', source.seasonId)
        .execute();
      await trx
        .updateTable('programs')
        .set({
          name: 'Junior Volleyball',
          starts_on: '2026-03-01',
          ends_on: '2026-11-30',
        })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', source.programId)
        .execute();
      await trx
        .updateTable('divisions')
        .set({
          name: 'U12 Girls',
          age_label: 'U12',
          competition_gender: 'female',
        })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', source.divisionId)
        .execute();
      await trx
        .updateTable('registration_offerings')
        .set({ name: 'Player registration', price_cents: 12500 })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', source.offeringId)
        .execute();
      await trx
        .updateTable('teams')
        .set({ name: 'Blue Comets' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', team.teamId)
        .execute();
      await trx
        .insertInto('team_staff')
        .values({
          id: randomUUID(),
          org_id: actor.orgId,
          team_season_id: team.teamSeasonId,
          person_id: coachPersonId,
          role: 'head_coach',
          status: 'active',
          added_by: actor.accountId,
        })
        .execute();
    });

    await signInAsOwner(page, testInfo, database, actor);
    await page.goto(`/console/orgs/${actor.orgId}/programs`);
    await expect(
      page.getByRole('heading', { name: 'Copy season' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByLabel('Source season').selectOption(source.seasonId);
    await page.getByLabel('New season name').fill('Fall 2027');
    await page.getByLabel('Starts').last().fill('2027-01-01');
    await page.getByLabel('Ends').last().fill('2027-12-31');
    await page.getByRole('button', { name: 'Preview copy' }).click();

    await expect(
      page.getByRole('heading', { name: 'Preview changes' }),
    ).toBeVisible();
    await expect(page.getByText('Fall 2026 → Fall 2027')).toBeVisible();
    await expect(page.getByText(/Copies 1 divisions: U12 Girls/)).toBeVisible();
    await expect(
      page.getByText(/Copies 1 offerings: Player registration/),
    ).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: 'Blue Comets' }),
    ).toBeChecked();
    await expect(
      page.getByRole('checkbox', { name: /Jordan Coach — head_coach/ }),
    ).toBeChecked();
    await expect(
      page.getByText(
        /Never copied: registrations, invoices, payments, results/,
      ),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'Copy season' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Copied 1 programs, 1 teams and 1 staff into Fall 2027',
    );
    await expect(page.getByText('Fall 2027 · planning')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    const copied = await createWithOrg(database)(actor, async (trx) => {
      const nextSeason = await trx
        .selectFrom('seasons')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('name', '=', 'Fall 2027')
        .executeTakeFirstOrThrow();
      const nextProgram = await trx
        .selectFrom('programs')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('season_id', '=', nextSeason.id)
        .where('copied_from_program_id', '=', source.programId)
        .executeTakeFirstOrThrow();
      const nextTeam = await trx
        .selectFrom('team_seasons')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('program_id', '=', nextProgram.id)
        .executeTakeFirstOrThrow();
      const nextStaff = await trx
        .selectFrom('team_staff')
        .select(['id', 'role', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('team_season_id', '=', nextTeam.id)
        .execute();
      return { nextSeason, nextProgram, nextStaff };
    });
    expect(copied.nextStaff).toHaveLength(1);
    expect(copied.nextStaff[0]).toMatchObject({
      role: 'head_coach',
      status: 'pending_compliance',
    });
  } finally {
    await database.destroy();
  }
});
