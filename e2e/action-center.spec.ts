import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('owner keyboard-operates the Action Center and report builder', async ({
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
    const markAllRead = page.getByRole('button', { name: 'Mark all read' });
    await markAllRead.focus();
    await expect(markAllRead).toBeFocused();
    await page.keyboard.press('Enter');
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

    await page.goto(`/console/orgs/${actor.orgId}/reports`);
    await expect(
      page.getByRole('heading', { name: 'Build a report' }),
    ).toBeVisible();
    const registrationPace = page.getByRole('button', {
      name: 'Registration pace',
    });
    await registrationPace.focus();
    await expect(registrationPace).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'Registration pace preset loaded.',
    );
    const preview = page.getByRole('button', { name: 'Preview report' });
    await preview.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'preview rows loaded.',
    );

    const reportName = page.getByLabel('Report name');
    await reportName.focus();
    await page.keyboard.type('Keyboard acceptance report');
    const saveReport = page.getByRole('button', { name: 'Save report' });
    await saveReport.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('Report saved.');
    await expect(
      page.getByRole('button', { name: /Keyboard acceptance report/ }),
    ).toBeVisible();

    const scheduleReport = page.getByRole('button', {
      name: 'Schedule report',
    });
    await scheduleReport.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'Secure report link scheduled',
    );
    const schedule = page
      .getByRole('row')
      .filter({ hasText: 'Keyboard acceptance report' });
    await expect(schedule).toContainText('weekly');
    await expect(schedule).toContainText('active');

    const pauseSchedule = schedule.getByRole('button', { name: 'Pause' });
    await pauseSchedule.focus();
    await page.keyboard.press('Enter');
    const resumeSchedule = schedule.getByRole('button', { name: 'Resume' });
    await expect(resumeSchedule).toBeVisible();
    await resumeSchedule.focus();
    await page.keyboard.press('Enter');
    await expect(schedule.getByRole('button', { name: 'Pause' })).toBeVisible();
  } finally {
    await database.destroy();
  }
});
