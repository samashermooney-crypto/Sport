import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');
const dayMilliseconds = 24 * 60 * 60 * 1000;
const timezone = 'America/Chicago';

function upcomingSaturday(): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  const daysUntilSaturday = (6 - date.getUTCDay() + 7) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + daysUntilSaturday);
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setTime(date.getTime() + count * dayMilliseconds);
  return date.toISOString().slice(0, 10);
}

function zonedInputValue(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (name: string): string => {
    const result = parts.find((item) => item.type === name)?.value;
    if (!result) throw new Error(`Missing ${name} in formatted date time.`);
    return result;
  };
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

test('staff edits the following events in a recurring weekly series', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const actor = await createTestFactories(database).actor();
    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute()
        .then(() => undefined),
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
    const baseURL = String(testInfo.project.use.baseURL);
    await page.context().addCookies([
      {
        name: '__Host-athlentry_session',
        value: session.token,
        url: baseURL,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    const firstDate = upcomingSaturday();
    const selectedDate = addDays(firstDate, 7);
    const lastDate = addDays(firstDate, 14);
    const originalTitle = 'Recurring acceptance practice';
    const updatedTitle = 'Updated recurring acceptance practice';

    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    const createDetails = page
      .locator('details')
      .filter({ hasText: 'Create a recurring weekly event' });
    await createDetails.locator('summary').click();
    const createForm = createDetails.locator('form');
    await createForm.getByLabel('Title *').fill(originalTitle);
    await createForm.getByLabel('First date *').fill(firstDate);
    await createForm.getByLabel('Last date *').fill(lastDate);
    await createForm.getByLabel('Weekday').selectOption('SA');
    await createForm.getByLabel('Start time').fill('18:00');
    await createForm.getByLabel('Duration (minutes)').fill('60');
    const createdResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/event-series'),
    );
    await createForm
      .getByRole('button', { name: 'Create weekly series' })
      .click();
    const created = await createdResponse;
    if (!created.ok())
      throw new Error(
        `Series creation failed (${String(created.status())}): ${await created.text()}`,
      );
    await expect(page.getByRole('status')).toHaveText(
      'Recurring series created. Its ID is ready in the edit form.',
    );

    const originalSeries = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('event_series')
        .select(['id', 'version', 'recurrence'])
        .where('org_id', '=', actor.orgId)
        .executeTakeFirstOrThrow(),
    );
    const originalOccurrences = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('events')
        .select(['id', 'starts_at', 'ends_at', 'title', 'series_id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('series_id', '=', originalSeries.id)
        .orderBy('starts_at')
        .execute(),
    );
    expect(originalOccurrences).toHaveLength(3);
    const selectedOccurrence = originalOccurrences[1];
    if (!selectedOccurrence) throw new Error('Second occurrence is missing.');
    expect(zonedInputValue(selectedOccurrence.starts_at, timezone)).toBe(
      `${selectedDate}T18:00`,
    );

    const editDetails = page
      .locator('details')
      .filter({ hasText: 'Edit this, following, or all series events' });
    await editDetails.locator('summary').click();
    const editForm = editDetails.locator('form');
    await editForm.getByLabel('Series version *').fill('1');
    await editForm
      .getByLabel('Occurrence start (local) *')
      .fill(zonedInputValue(selectedOccurrence.starts_at, timezone));
    await editForm.getByLabel('Edit scope').selectOption('following');
    await editForm.getByLabel('New title').fill(updatedTitle);
    await editForm.getByLabel('Future series start date').fill(selectedDate);
    await editForm.getByLabel('Future series end date').fill(lastDate);
    await editForm.getByLabel('Future series weekday').selectOption('SA');
    await editForm.getByLabel('Future series start time').fill('19:30');
    await editForm.getByLabel('Future series duration').fill('90');
    const editResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes(`/event-series/${originalSeries.id}`),
    );
    await editForm.getByRole('button', { name: 'Save series edit' }).click();
    const edited = await editResponse;
    if (!edited.ok())
      throw new Error(
        `Series edit failed (${String(edited.status())}): ${await edited.text()}`,
      );
    await expect(page.getByRole('status')).toHaveText('Series changes saved.');

    const changedEvents = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('events')
        .select(['starts_at', 'ends_at', 'title', 'series_id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('title', 'in', [originalTitle, updatedTitle])
        .orderBy('starts_at')
        .execute(),
    );
    const preserved = changedEvents.filter(
      (event) => event.status === 'scheduled' && event.title === originalTitle,
    );
    const canceled = changedEvents.filter(
      (event) => event.status === 'canceled' && event.title === originalTitle,
    );
    const rescheduled = changedEvents.filter(
      (event) => event.status === 'scheduled' && event.title === updatedTitle,
    );
    expect(preserved).toHaveLength(1);
    expect(canceled).toHaveLength(2);
    expect(rescheduled).toHaveLength(2);
    expect(preserved[0]?.series_id).toBe(originalSeries.id);
    expect(
      canceled.every((event) => event.series_id === originalSeries.id),
    ).toBe(true);
    expect(
      rescheduled.every((event) => event.series_id !== originalSeries.id),
    ).toBe(true);
    for (const event of rescheduled) {
      expect(
        zonedInputValue(event.starts_at, timezone).endsWith('T19:30'),
      ).toBe(true);
      expect(event.ends_at.getTime() - event.starts_at.getTime()).toBe(
        90 * 60 * 1000,
      );
    }
    const nextSeriesId = rescheduled[0]?.series_id;
    if (!nextSeriesId) throw new Error('Edited series ID is missing.');
    expect(rescheduled.every((event) => event.series_id === nextSeriesId)).toBe(
      true,
    );
    const [truncatedSeries, nextSeries] = await createWithOrg(database)(
      actor,
      (trx) =>
        Promise.all([
          trx
            .selectFrom('event_series')
            .select(['version', 'recurrence'])
            .where('org_id', '=', actor.orgId)
            .where('id', '=', originalSeries.id)
            .executeTakeFirstOrThrow(),
          trx
            .selectFrom('event_series')
            .select(['version', 'recurrence'])
            .where('org_id', '=', actor.orgId)
            .where('id', '=', nextSeriesId)
            .executeTakeFirstOrThrow(),
        ]),
    );
    expect(truncatedSeries.version).toBe(2);
    expect(nextSeries.version).toBe(1);
    const nextRecurrence = nextSeries.recurrence as { startsOn?: string };
    expect(nextRecurrence.startsOn).toBe(selectedDate);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
