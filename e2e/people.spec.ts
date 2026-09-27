import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('owner creates, edits and archives a person from the console', async ({
  page,
}, testInfo) => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const actor = await createTestFactories(database).actor();
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
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
    await page.goto(`/console/orgs/${actor.orgId}`);
    await page.getByRole('link', { name: 'Manage people' }).click();
    await expect(
      page.getByRole('heading', { name: 'People', exact: true }),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'First name' }).fill('Alex');
    await page.getByRole('textbox', { name: 'Last name' }).fill('Rivera');
    await page.getByLabel('Date of birth').fill('2011-04-12');
    await page.getByRole('button', { name: 'Create person' }).click();
    await expect(
      page.getByRole('heading', { name: 'Alex Rivera' }),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Preferred name' }).fill('Lex');
    const savedPerson = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes(`/api/v1/people/orgs/${actor.orgId}/`),
    );
    await page.getByRole('button', { name: 'Save person' }).click();
    expect((await savedPerson).ok()).toBe(true);
    await expect(
      page.getByRole('textbox', { name: 'Preferred name' }),
    ).toHaveValue('Lex');
    expect(await accessibilityViolations(page)).toEqual([]);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Archive person' }).click();
    await expect(page).toHaveURL(`/console/orgs/${actor.orgId}/people`);
    await expect(
      page.getByText('No active people match this search.'),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Status' })
      .selectOption('archived');
    await expect(page.getByRole('link', { name: 'Alex Rivera' })).toBeVisible();
    await page.getByRole('link', { name: 'Alex Rivera' }).click();
    await page.getByRole('button', { name: 'Restore person' }).click();
    await expect(
      page.getByRole('button', { name: 'Save person' }),
    ).toBeVisible();
    await page.goto(`/console/orgs/${actor.orgId}/households`);
    await page
      .getByRole('textbox', { name: 'Household name' })
      .fill('Rivera household');
    await page.getByRole('button', { name: 'Create household' }).click();
    await expect(
      page.getByRole('heading', { name: 'Rivera household' }),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Person' })
      .selectOption({ label: 'Alex Rivera' });
    await page.getByRole('button', { name: 'Add member' }).click();
    await expect(page.getByRole('link', { name: 'Alex Rivera' })).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
