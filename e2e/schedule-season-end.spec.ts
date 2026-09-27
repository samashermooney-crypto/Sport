import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('season end collects family feedback, ratings, awards, and archive', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const team = await factories.team(actor, program);
    const personId = await factories.person(actor, {
      firstName: 'Jamie',
      lastName: 'Award Athlete',
      dateOfBirth: '2012-05-04',
    });
    const householdId = await factories.household(actor);
    await factories.registration(actor, program, personId, householdId);
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

    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    await page.getByLabel('Program ID *').fill(program.programId);
    const panel = page.locator('section[aria-labelledby="season-end-heading"]');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Family survey title').fill('Season feedback');
    await panel.getByLabel('Family survey language').selectOption('es');
    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response
          .url()
          .endsWith(`/programs/${program.programId}/season-surveys`),
    );
    await panel.getByRole('button', { name: 'Create survey' }).click();
    expect((await createResponse).ok()).toBe(true);
    const campaign = panel.locator('.schedule-run').filter({
      hasText: 'Season feedback',
    });
    await campaign.getByRole('button', { name: 'Open survey' }).click();
    await expect(campaign.getByText('open')).toBeVisible();

    await page.goto(
      `/portal/orgs/${actor.orgId}/schedule/teams/${team.teamSeasonId}/people/${personId}`,
    );
    const familySurvey = page.locator(
      'section[aria-labelledby="family-surveys-heading"]',
    );
    await expect(
      familySurvey.getByRole('heading', { name: 'Season feedback' }),
    ).toBeVisible();
    await familySurvey
      .getByLabel(
        '¿Qué probabilidad hay de que recomiende este programa? (0–10)',
      )
      .selectOption('9');
    await familySurvey
      .getByLabel('Comentarios')
      .fill('Gracias por una great season.');
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/season-surveys/') &&
        response.url().endsWith('/responses'),
    );
    await familySurvey
      .getByRole('button', { name: 'Enviar comentarios' })
      .click();
    expect((await responsePromise).ok()).toBe(true);
    await expect(page.getByRole('status')).toHaveText(
      'Thank you. Your response is saved.',
    );
    expect(await accessibilityViolations(page)).toEqual([]);

    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    await page.getByLabel('Program ID *').fill(program.programId);
    const staffPanel = page.locator(
      'section[aria-labelledby="season-end-heading"]',
    );
    const refreshedCampaign = staffPanel.locator('.schedule-run').filter({
      hasText: 'Season feedback',
    });
    await refreshedCampaign
      .getByRole('button', { name: 'Close survey' })
      .click();
    const awaitedCampaignId = await refreshedCampaign
      .locator('code')
      .textContent();
    if (!awaitedCampaignId) throw new Error('Season survey ID is missing.');
    const resultsResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().endsWith(`/season-surveys/${awaitedCampaignId}/results`),
    );
    await refreshedCampaign
      .getByRole('button', { name: 'View results' })
      .click();
    expect((await resultsResponse).ok()).toBe(true);
    const results = staffPanel.locator('pre.schedule-json');
    await expect(results).toContainText('"responseCount": 1');
    await expect(results).toContainText('"nps": 100');
    await expect(results).toContainText('Gracias por una great season.');
    await refreshedCampaign
      .getByRole('button', { name: 'Archive survey' })
      .click();
    await expect(refreshedCampaign.getByText('archived')).toBeVisible();

    const awardForm = staffPanel.locator('form').nth(1);
    await awardForm.getByLabel('Award title').fill('Most Improved');
    await awardForm.getByLabel('Person ID').fill(personId);
    const awardResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/programs/${program.programId}/season-awards`),
    );
    await awardForm.getByRole('button', { name: 'Issue award' }).click();
    expect((await awardResponse).ok()).toBe(true);
    await expect(staffPanel.getByText('Most Improved')).toBeVisible();
    const popupPromise = page.waitForEvent('popup');
    await staffPanel
      .getByRole('button', { name: 'Print certificates / Save PDF' })
      .click();
    const certificate = await popupPromise;
    await expect(
      certificate.getByRole('heading', { name: 'Jamie Award Athlete' }),
    ).toBeVisible();
    await expect(
      certificate.getByRole('heading', { name: 'Most Improved' }),
    ).toBeVisible();

    const ratingForm = staffPanel.locator('form').nth(2);
    await ratingForm.getByLabel('Team season ID').fill(team.teamSeasonId);
    await ratingForm.getByLabel('Player ID').fill(personId);
    await ratingForm.getByLabel('Rating (1–5)').fill('5');
    await ratingForm.getByLabel('Returning next season').check();
    const ratingResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response
          .url()
          .endsWith(`/team-seasons/${team.teamSeasonId}/player-ratings`),
    );
    await ratingForm.getByRole('button', { name: 'Save rating' }).click();
    expect((await ratingResponse).ok()).toBe(true);
    await expect(page.getByRole('status')).toHaveText('Player rating saved.');

    const seasonState = await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ status: 'completed' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('seasons')
        .set({ status: 'completed' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.seasonId)
        .execute();
      return trx
        .selectFrom('seasons')
        .select('version')
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.seasonId)
        .executeTakeFirstOrThrow();
    });
    const archiveForm = staffPanel.locator('form').nth(3);
    await archiveForm.getByLabel('Season ID').fill(program.seasonId);
    await archiveForm
      .getByLabel('Season version')
      .fill(String(seasonState.version));
    const archiveResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/seasons/${program.seasonId}/archive`),
    );
    await archiveForm.getByRole('button', { name: 'Archive season' }).click();
    expect((await archiveResponse).ok()).toBe(true);
    const archived = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('seasons')
        .select('status')
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.seasonId)
        .executeTakeFirstOrThrow(),
    );
    expect(archived.status).toBe('archived');
  } finally {
    await database.destroy();
  }
});
