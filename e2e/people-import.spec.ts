import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('staff previews, commits, and rolls back an import from the console', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const email = `import-${randomUUID()}@example.invalid`;
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
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

    await page.goto(`/console/orgs/${actor.orgId}/imports`);
    await expect(
      page.getByRole('heading', { name: 'Import records' }),
    ).toBeVisible();
    const csv = [
      'First Name,Last Name,DOB,Email',
      `Ava,Mooney,2012-04-03,${email}`,
      `Missing,,2011-01-01,invalid-${randomUUID()}@example.invalid`,
    ].join('\n');
    await page.getByLabel(/CSV or XLSX file/).setInputFiles({
      name: 'roster.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await expect(page.getByText('Selected: roster.csv')).toBeVisible();
    await page.getByRole('button', { name: 'Preview import' }).click();
    await expect(
      page.getByRole('heading', { name: 'Batch preview' }),
    ).toBeVisible();
    await expect(page.getByText('1 to create')).toBeVisible();
    await expect(page.getByText('1 invalid')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'Commit valid rows' }).click();
    await expect(
      page.getByText(/roster\.csv · 2 rows · committed/),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Roll back untouched rows' })
      .click();
    await expect(
      page.getByText(/roster\.csv · 2 rows · rolled_back/),
    ).toBeVisible();

    const imported = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('people')
        .select('status')
        .where('org_id', '=', actor.orgId)
        .where('email', '=', email)
        .executeTakeFirstOrThrow(),
    );
    expect(imported.status).toBe('archived');
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
