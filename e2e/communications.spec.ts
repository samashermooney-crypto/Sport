import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import pg from 'pg';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createConversation } from '../server/src/modules/chat/service';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';
import { e2eDatabaseUrl } from './database';


async function signInBrowser(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  database: ReturnType<typeof createDatabase>,
  accountId: string,
) {
  const session = await database.transaction().execute((trx) =>
    issueSession(
      trx,
      {
        accountId,
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
  await page.addInitScript(() => {
    localStorage.setItem('athlentry-language', 'en');
  });
}

test('staff builds a bilingual campaign, reviews its audience, test-sends in-app, and cancels a schedule', async ({
  page,
}, testInfo) => {
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  try {
    const actor = await createTestFactories(database).actor();
    const withOrg = createWithOrg(database);
    await withOrg(actor, (trx) =>
      trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute(),
    );
    await signInBrowser(page, testInfo, database, actor.accountId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/console/orgs/${actor.orgId}/messages`);
    await expect(page.locator('.ui-app-shell')).toHaveCount(1);
    await expect(
      page.getByRole('heading', { name: 'Messages', exact: true }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'New campaign' }).click();
    await page.getByRole('checkbox', { name: 'Email' }).uncheck();
    const audiencePreview = page.waitForResponse(
      (response) =>
        response.url().includes('/audience-preview') &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('checkbox', { name: 'Owners and administrators' })
      .first()
      .check();
    await audiencePreview;
    await expect(
      page.getByRole('heading', { name: /Audience preview · 1 people/ }),
    ).toBeVisible();
    await page.getByLabel('Subject').fill('Practice update');
    await page
      .getByRole('textbox', { name: 'English email content' })
      .fill('Practice starts at 6.');
    await page.getByLabel('Plain text').fill('Practice starts at 6.');
    await page.getByRole('tab', { name: 'Español', exact: true }).click();
    await page.getByLabel('Subject').fill('Actualización de práctica');
    await page
      .getByRole('textbox', { name: 'Spanish email content' })
      .fill('La práctica empieza a las 6.');
    await page.getByLabel('Plain text').fill('La práctica empieza a las 6.');
    await page.getByRole('tab', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: '{{guardian.first_name}}' }).click();

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByRole('status')).toContainText('Draft created.');
    await page.getByRole('button', { name: 'Send test to me' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Test sent to your account: in_app sent.',
    );

    const scheduleAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);
    await page.getByLabel('Schedule date and time').fill(scheduleAt);
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Campaign scheduled.');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Cancel schedule' }).click();
    await expect(page.getByRole('status')).toContainText('Campaign canceled.');
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});

test('family sends a chat message from the mobile portal with realtime controls accessible', async ({
  page,
}, testInfo) => {
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  const admin = new pg.Client({
    connectionString: e2eDatabaseUrl('admin'),
  });
  try {
    const actor = await createTestFactories(database).actor();
    const peerId = randomUUID();
    await admin.connect();
    await admin.query(
      `INSERT INTO accounts
        (id, email, email_verified_at, first_name, last_name, date_of_birth)
       VALUES ($1, $2, now(), 'Portal', 'Peer', '1990-01-01')`,
      [peerId, `${peerId}@example.invalid`],
    );
    await admin.query(
      `INSERT INTO org_memberships (id, org_id, account_id, status, joined_at)
       VALUES ($1, $2, $3, 'active', now())`,
      [randomUUID(), actor.orgId, peerId],
    );
    await admin.end();

    const conversation = await createConversation(
      actor,
      { kind: 'direct', title: 'Family and coach', accountIds: [peerId] },
      new Date(),
      createWithOrg(database),
    );
    await signInBrowser(page, testInfo, database, actor.accountId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/me/orgs/${actor.orgId}/messages?conversation=${conversation.id}`,
    );
    await expect(
      page.getByRole('heading', { name: 'Messages', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Family and coach', exact: true }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    await page.getByLabel('Write a message').fill('Practice begins at 6.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Practice begins at 6.')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await admin.end().catch(() => undefined);
    await database.destroy();
  }
});
