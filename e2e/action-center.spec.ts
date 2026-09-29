import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('owner marks unread website contacts read from the Action Center', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const contactId = newId();
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
      await trx
        .insertInto('contact_submissions')
        .values({
          id: contactId,
          org_id: actor.orgId,
          name: 'Jordan Parent',
          email: 'jordan@example.invalid',
          subject: 'Schedule question',
          body: 'When does the season schedule publish?',
          status: 'new',
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
    await page.addInitScript(() => {
      localStorage.setItem('athlentry-language', 'en');
    });

    await page.goto(`/console/orgs/${actor.orgId}/action-center`);
    await expect(
      page.getByRole('heading', { name: 'Unread website contact submissions' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Mark all read' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    const markedRead = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/contact-submissions/mark-read'),
    );
    await page.getByRole('button', { name: 'Mark all read' }).click();
    const markReadResponse = await markedRead;
    expect(
      markReadResponse.ok(),
      `mark-read returned ${String(markReadResponse.status())}: ${await markReadResponse.text()}`,
    ).toBe(true);
    await expect(page.getByRole('status')).toContainText(
      '1 message marked as read.',
    );
    await expect(
      page.getByRole('heading', { name: 'Everything is up to date' }),
    ).toBeVisible();

    const saved = await withOrg(actor, (trx) =>
      trx
        .selectFrom('contact_submissions')
        .select('status')
        .where('id', '=', contactId)
        .executeTakeFirstOrThrow(),
    );
    expect(saved.status).toBe('read');
  } finally {
    await database.destroy();
  }
});
