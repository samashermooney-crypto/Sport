import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';
import { e2eDatabaseUrl } from './database';

test('owner opens the safety center and person portal on desktop and phone', async ({
  page,
}, testInfo) => {
  const database = createDatabase(e2eDatabaseUrl('app'));
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const personId = await factories.person(actor);
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
    await page.goto(`/console/orgs/${actor.orgId}`);
    await page
      .locator('.console-home__cards')
      .getByRole('link', { name: 'Open safety center' })
      .click();
    await expect(page).toHaveURL(`/console/safety/${actor.orgId}`);
    await expect(
      page.getByRole('heading', { name: 'Safety and compliance' }),
    ).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Safety tasks' }),
    ).toBeVisible();
    await expect(page.locator('.ui-app-shell')).toHaveCount(1);
    expect(await accessibilityViolations(page)).toEqual([]);
    await page
      .getByRole('link', { name: 'Credential types and requirements' })
      .click();
    await expect(page).toHaveURL(`/console/safety/${actor.orgId}/requirements`);
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.goto(`/me/safety/${actor.orgId}/people/${personId}`);
    await expect(
      page.getByRole('heading', { name: 'Safety and compliance' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Credentials' }),
    ).toBeVisible();
    await expect(page.locator('.ui-app-shell')).toHaveCount(1);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
