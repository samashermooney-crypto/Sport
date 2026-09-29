import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('owner keyboard-operates Action Center reminders and the report builder', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const contactId = newId();
  const invoiceId = newId();
  const invoiceLineId = newId();
  const familyAccountId = newId();
  const dueOn = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  try {
    const actor = await createTestFactories(database).actor();
    const withOrg = createWithOrg(database);
    await database
      .insertInto('accounts')
      .values({
        id: familyAccountId,
        email: `action-center-family-${familyAccountId}@example.invalid`,
        first_name: 'Taylor',
        last_name: 'Family',
        date_of_birth: '1985-01-01',
      })
      .execute();
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
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: actor.orgId,
          account_id: familyAccountId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('invoices')
        .values({
          id: invoiceId,
          org_id: actor.orgId,
          number: 1,
          account_id: familyAccountId,
          status: 'past_due',
          source: 'staff',
          subtotal_cents: 2500,
          total_cents: 2500,
          due_on: dueOn,
        })
        .execute();
      await trx
        .insertInto('invoice_lines')
        .values({
          id: invoiceLineId,
          org_id: actor.orgId,
          invoice_id: invoiceId,
          kind: 'adjustment',
          description: 'Action Center reminder test balance',
          quantity: 1,
          unit_amount_cents: 2500,
          amount_cents: 2500,
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
    await expect(
      page.getByRole('heading', { name: 'Past-due unpaid balances' }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    const sendReminders = page.getByRole('button', {
      name: 'Send in-app reminders',
    });
    const firstReminder = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/actions/past-due-reminders'),
    );
    await sendReminders.focus();
    await page.keyboard.press('Enter');
    const firstReminderResponse = await firstReminder;
    const firstReminderBody = await firstReminderResponse.text();
    expect(
      firstReminderResponse.ok(),
      `past-due reminders returned ${String(firstReminderResponse.status())}: ${firstReminderBody}`,
    ).toBe(true);
    expect(JSON.parse(firstReminderBody)).toEqual({
      sentCount: 1,
      skippedCount: 0,
    });
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'reminder notifications sent' }),
    ).toContainText('1 reminder notifications sent to the app inbox');

    const duplicateReminder = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/actions/past-due-reminders'),
    );
    await sendReminders.focus();
    await page.keyboard.press('Enter');
    const duplicateReminderResponse = await duplicateReminder;
    expect(duplicateReminderResponse.ok()).toBe(true);
    await expect(duplicateReminderResponse.json()).resolves.toEqual({
      sentCount: 0,
      skippedCount: 1,
    });
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'reminder notifications sent' }),
    ).toContainText(
      '0 reminder notifications sent to the app inbox; 1 skipped',
    );

    const notification = await withOrg(actor, (trx) =>
      trx
        .selectFrom('notifications')
        .select(['account_id', 'delivered_channels', 'payload'])
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', familyAccountId)
        .where('type', '=', 'finance.payment_due')
        .executeTakeFirstOrThrow(),
    );
    expect(notification.account_id).toBe(familyAccountId);
    expect(notification.delivered_channels).toEqual(['in_app']);
    expect(notification.payload).toMatchObject({
      resourceType: 'invoice',
      resourceId: invoiceId,
      href: `/portal/orgs/${actor.orgId}/money/invoices`,
    });

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
    await expect(
      page.getByRole('status').filter({ hasText: 'message marked as read' }),
    ).toContainText('1 message marked as read.');
    await expect(
      page.getByRole('heading', { name: 'Past-due unpaid balances' }),
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
    const evaluationResults = page.getByRole('button', {
      name: 'Evaluation results',
    });
    await evaluationResults.focus();
    await expect(evaluationResults).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Evaluation results preset loaded.' }),
    ).toContainText('Evaluation results preset loaded.');
    const preview = page.getByRole('button', { name: 'Preview report' });
    await preview.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('status').filter({ hasText: 'preview rows loaded.' }),
    ).toContainText('preview rows loaded.');

    const registrationPace = page.getByRole('button', {
      name: 'Registration pace',
    });
    await registrationPace.focus();
    await expect(registrationPace).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Registration pace preset loaded.' }),
    ).toContainText('Registration pace preset loaded.');
    await preview.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('status').filter({ hasText: 'preview rows loaded.' }),
    ).toContainText('preview rows loaded.');

    const reportName = page.getByLabel('Report name');
    await reportName.focus();
    await page.keyboard.type('Keyboard acceptance report');
    const saveReport = page.getByRole('button', { name: 'Save report' });
    await saveReport.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('status').filter({ hasText: 'Report saved.' }),
    ).toContainText('Report saved.');
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
