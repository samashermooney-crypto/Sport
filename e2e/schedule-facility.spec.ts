import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('staff publishes a facility page with its public space listing', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const actor = await createTestFactories(database).actor();
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
    const facilities = page.locator(
      'section[aria-labelledby="schedule-facilities-heading"]',
    );
    const facilityForm = facilities.locator('form').first();
    const facilityResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/facilities'),
    );
    await facilityForm
      .getByLabel('Facility name *')
      .fill('East Community Park');
    await facilityForm
      .getByLabel('Parking notes')
      .fill('Use the east entrance and overflow lot.');
    await facilityForm
      .getByLabel('Facility layout image')
      .setInputFiles('server/test/fixtures/gps-photo.jpg');
    await facilityForm.getByLabel('List publicly').check();
    await facilityForm.getByRole('button', { name: 'Add facility' }).click();
    const facilityCreated = await facilityResponse;
    expect(facilityCreated.ok()).toBe(true);
    const facility = (await facilityCreated.json()) as {
      id: string;
      layout_image_file_id: string | null;
    };
    expect(facility.layout_image_file_id).toBeTruthy();
    await expect(
      page.getByText('Facility created.', { exact: true }),
    ).toBeVisible();

    const spaceDetails = facilities
      .locator('details')
      .filter({ hasText: 'Add a bookable space' });
    await spaceDetails
      .getByText('Add a bookable space', { exact: true })
      .click();
    const spaceForm = spaceDetails.locator('form');
    const spaceResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/spaces'),
    );
    await spaceForm.getByLabel('Facility *').selectOption(facility.id);
    await spaceForm.getByLabel('Space name *').fill('East Turf Field');
    await spaceForm.getByLabel('Space type *').selectOption('field');
    await spaceForm.getByLabel('Surface').fill('Synthetic turf');
    await spaceForm.getByRole('button', { name: 'Add space' }).click();
    expect((await spaceResponse).ok()).toBe(true);
    await expect(
      page.getByText('Bookable space created.', { exact: true }),
    ).toBeVisible();

    const facilityRow = facilities
      .getByRole('listitem')
      .filter({ hasText: 'East Community Park' });
    await facilityRow
      .getByText('Calendar subscription', { exact: true })
      .click();
    const feedPanel = facilityRow.getByRole('region', {
      name: 'East Community Park facility calendar subscriptions',
    });
    const feedCreateResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/calendar-feeds'),
    );
    await feedPanel
      .getByRole('button', {
        name: 'Create East Community Park facility calendar feed',
      })
      .click();
    const createdFeed = (await (await feedCreateResponse).json()) as {
      id: string;
      url: string;
    };
    expect(createdFeed.url).toMatch(/\/feeds\/[A-Za-z0-9_-]{43}\.ics$/);
    const feedUrl = new URL(
      createdFeed.url,
      String(testInfo.project.use.baseURL),
    );
    expect((await page.request.get(feedUrl.toString())).ok()).toBe(true);
    await expect(
      feedPanel.getByLabel('East Community Park facility calendar URL'),
    ).toHaveValue(feedUrl.toString());

    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    const revokeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/calendar-feeds/${createdFeed.id}`),
    );
    await feedPanel.getByRole('button', { name: 'Revoke URL' }).click();
    expect((await revokeResponse).status()).toBe(204);
    expect((await page.request.get(feedUrl.toString())).status()).toBe(404);

    const organization = await database
      .selectFrom('organizations')
      .select('slug')
      .where('id', '=', actor.orgId)
      .executeTakeFirstOrThrow();
    await page.route(
      (url) =>
        url.pathname ===
        `/api/v1/files/public/orgs/${encodeURIComponent(organization.slug)}/facilities/${encodeURIComponent(facility.id)}/layout`,
      async (route) =>
        route.fulfill({
          status: 200,
          contentType: 'image/jpeg',
          body: await readFile('server/test/fixtures/gps-photo.jpg'),
        }),
    );
    await page.goto(`/orgs/${organization.slug}/facilities/${facility.id}`);
    await expect(
      page.getByRole('heading', { name: 'East Community Park' }),
    ).toBeVisible();
    await expect(
      page.getByText('Use the east entrance and overflow lot.'),
    ).toBeVisible();
    await expect(page.getByText('East Turf Field · field')).toBeVisible();
    await expect(
      page.getByRole('img', {
        name: 'East Community Park facility layout',
      }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
