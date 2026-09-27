import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('payer opens working finance pages from the family portal', async ({
  page,
}, testInfo) => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const actor = await createTestFactories(database).actor();
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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/portal/orgs/${actor.orgId}/notifications`);
    await page
      .getByRole('navigation', { name: 'Mobile navigation' })
      .getByRole('link', { name: 'Payments' })
      .click();
    await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Payment pages' })
      .getByRole('link', { name: 'Invoices' })
      .click();
    await expect(page.getByText('No invoices yet.')).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Payment pages' })
      .getByRole('link', { name: 'Receipts' })
      .click();
    await expect(page.getByText('No receipts yet.')).toBeVisible();
    await page.route('**/api/v1/finance/stripe-client-config', (route) =>
      route.fulfill({
        json: { publishableKey: 'pk_test_finance_portal' },
      }),
    );
    await page.route('**/api/v1/finance/me/payment-methods', (route) =>
      route.fulfill({
        json: { methods: [], defaultMethodId: null },
      }),
    );
    await page
      .getByRole('navigation', { name: 'Payment pages' })
      .getByRole('link', { name: 'Payment methods' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Saved payment methods' }),
    ).toBeVisible();
    await expect(page.getByText('No saved payment methods yet.')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
