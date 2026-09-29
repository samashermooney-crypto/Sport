import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import {
  issueSession,
  resolveSession,
  rotateSessionForStepUp,
} from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('owner requests, downloads and verifies an organization export', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const now = new Date();

  try {
    const actor = await createTestFactories(database).actor();
    const withOrg = createWithOrg(database);
    await withOrg(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
    });

    const session = await database.transaction().execute(async (trx) => {
      const issued = await issueSession(
        trx,
        {
          accountId: actor.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: true,
          mfaVerifiedAt: now,
        },
        now,
      );
      const active = await resolveSession(trx, issued.token, now);
      if (!active) throw new Error('Could not resolve newly issued session');
      const rotated = await rotateSessionForStepUp(trx, active, now, {}, now);
      if (!rotated) throw new Error('Could not rotate session for step-up');
      return rotated;
    });

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
    await page.addInitScript(() => {
      localStorage.setItem('athlentry-language', 'en');
    });

    await page.goto(`/console/orgs/${actor.orgId}/data`);
    await expect(
      page.getByRole('heading', { name: 'Exports', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Request export' }).click();
    await expect(page.getByText(/Export request queued/)).toBeVisible();

    const exportId = await withOrg(actor, async (trx) => {
      const row = await trx
        .selectFrom('org_data_exports')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .orderBy('created_at', 'desc')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    await expect
      .poll(
        () =>
          withOrg(actor, async (trx) => {
            const row = await trx
              .selectFrom('org_data_exports')
              .select('status')
              .where('org_id', '=', actor.orgId)
              .where('id', '=', exportId)
              .executeTakeFirst();
            return row?.status ?? null;
          }),
        { timeout: 45_000, intervals: [250, 500, 1_000] },
      )
      .toBe('ready');

    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('ready', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'Create secure download link' })
      .click();
    const downloadLink = page.getByRole('link', {
      name: 'Download organization ZIP',
    });
    await expect(downloadLink).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadLink.click(),
    ]);
    expect(download.suggestedFilename()).toBe(
      'athlentry-organization-export.zip',
    );
    const path = await download.path();
    expect(path).toBeTruthy();
    const bytes = await readFile(path);
    expect(bytes.byteLength).toBeGreaterThan(100);
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK');
  } finally {
    await database.destroy();
  }
});
