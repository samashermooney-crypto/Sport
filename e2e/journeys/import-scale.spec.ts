import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';
import { accessibilityViolations } from '../axe';
import { e2eDatabaseUrl } from '../database';

const importSize = 2_000;

test('staff previews, imports, and rolls back a 2,000-person batch on desktop', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const database = createDatabase(e2eDatabaseUrl('app'));
  const importPrefix = `import-${randomUUID()}`;
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
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

    const rows = Array.from({ length: importSize }, (_, index) => {
      const rowNumber = String(index + 1).padStart(4, '0');
      return `Athlete${rowNumber},Roster,2012-04-03,${importPrefix}-${rowNumber}@example.invalid`;
    });
    const csv = ['First Name,Last Name,DOB,Email', ...rows].join('\n');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/console/orgs/${actor.orgId}/imports`);
    await expect(
      page.getByRole('heading', { name: 'Import records' }),
    ).toBeVisible();
    await page.getByLabel(/CSV or XLSX file/).setInputFiles({
      name: 'two-thousand-athletes.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await page.getByRole('button', { name: 'Preview import' }).click();
    await expect(
      page.getByRole('heading', { name: 'Batch preview' }),
    ).toBeVisible();
    await expect(
      page.getByText('2000 to create', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('0 invalid', { exact: true })).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'Commit valid rows' }).click();
    await expect(
      page.getByText(/two-thousand-athletes\.csv · 2000 rows · committed/),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Roll back untouched rows' })
      .click();
    await expect(
      page.getByText(/two-thousand-athletes\.csv · 2000 rows · rolled_back/),
    ).toBeVisible();

    const imported = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('people')
        .select('status')
        .where('org_id', '=', actor.orgId)
        .where('email', 'like', `${importPrefix}-%@example.invalid`)
        .execute(),
    );
    expect(imported).toHaveLength(importSize);
    expect(new Set(imported.map((person) => person.status))).toEqual(
      new Set(['archived']),
    );
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
