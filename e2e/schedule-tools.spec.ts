import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');
const dayMilliseconds = 24 * 60 * 60 * 1000;
const timezone = 'America/Chicago';

function localInput(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
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

function utcDateInput(value: Date): string {
  return value.toISOString().slice(0, 10);
}

test('staff publishes, edits, exports, reschedules, and imports a schedule', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const [home, away] = await Promise.all([
      factories.team(actor, program),
      factories.team(actor, program),
    ]);
    const personId = await factories.person(actor, {
      firstName: 'Schedule',
      lastName: 'Recipient',
      dateOfBirth: '1990-01-01',
    });
    const eventId = newId();
    const originalTitle = 'Manual schedule acceptance game';
    const updatedTitle = 'Published schedule acceptance game';
    const startsAt = new Date();
    startsAt.setUTCDate(startsAt.getUTCDate() + 7);
    startsAt.setUTCHours(18, 0, 0, 0);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const proposedStartsAt = new Date(startsAt.getTime() + 2 * dayMilliseconds);
    const proposedEndsAt = new Date(
      proposedStartsAt.getTime() + 60 * 60 * 1000,
    );
    const importStartsAt = new Date(startsAt.getTime() + 14 * dayMilliseconds);
    const importEndsAt = new Date(importStartsAt.getTime() + 60 * 60 * 1000);

    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: actor.orgId,
          person_id: personId,
          account_id: actor.accountId,
          relationship: 'self',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('events')
        .values({
          id: eventId,
          org_id: actor.orgId,
          program_id: program.programId,
          division_id: program.divisionId,
          kind: 'game',
          title: originalTitle,
          starts_at: startsAt,
          ends_at: endsAt,
          timezone,
          location_text: 'North Park Field',
        })
        .execute();
      await trx
        .insertInto('event_participants')
        .values([
          {
            id: newId(),
            org_id: actor.orgId,
            event_id: eventId,
            team_season_id: home.teamSeasonId,
            person_id: null,
            side: 'home',
          },
          {
            id: newId(),
            org_id: actor.orgId,
            event_id: eventId,
            team_season_id: away.teamSeasonId,
            person_id: null,
            side: 'away',
          },
          {
            id: newId(),
            org_id: actor.orgId,
            event_id: eventId,
            team_season_id: null,
            person_id: personId,
            side: 'none',
          },
        ])
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

    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    const eventRow = page.getByRole('row').filter({ hasText: originalTitle });
    await expect(eventRow).toBeVisible();
    await eventRow.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('status')).toHaveText('Event published.');
    await expect(
      eventRow.getByText('Published', { exact: true }),
    ).toBeVisible();

    await eventRow.getByRole('button', { name: originalTitle }).click();
    const editDetails = page
      .locator('details')
      .filter({ hasText: 'Edit selected event' });
    await page.getByText('Edit selected event', { exact: true }).click();
    const eventEditForm = editDetails.locator('form').first();
    await editDetails
      .getByRole('button', { name: 'Swap home and away' })
      .click();
    await expect(page.getByRole('status')).toHaveText(
      'Home and away teams swapped.',
    );
    const swapped = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('event_participants')
        .select(['team_season_id', 'side'])
        .where('org_id', '=', actor.orgId)
        .where('event_id', '=', eventId)
        .where('team_season_id', 'is not', null)
        .execute(),
    );
    expect(swapped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          team_season_id: home.teamSeasonId,
          side: 'away',
        }),
        expect.objectContaining({
          team_season_id: away.teamSeasonId,
          side: 'home',
        }),
      ]),
    );

    await eventEditForm.getByLabel('Event title *').fill(updatedTitle);
    await eventEditForm
      .getByLabel('Start (event timezone) *')
      .fill(localInput(new Date(startsAt.getTime() + 60 * 60 * 1000)));
    await eventEditForm
      .getByLabel('End (event timezone) *')
      .fill(localInput(new Date(endsAt.getTime() + 60 * 60 * 1000)));
    await eventEditForm
      .getByLabel('Location text')
      .fill('Updated North Park Field');
    await eventEditForm
      .getByRole('button', { name: 'Save event changes' })
      .click();
    await expect(page.getByRole('status')).toHaveText('Event updated.');

    const editedEvent = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('events')
        .select(['title', 'starts_at', 'published'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow(),
    );
    expect(editedEvent.title).toBe(updatedTitle);
    expect(editedEvent.starts_at.getTime()).toBe(
      startsAt.getTime() + 60 * 60 * 1000,
    );
    expect(editedEvent.published).toBe(true);

    const batches = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('schedule_change_batches')
        .select(['notification_type', 'emit_after', 'changes'])
        .where('org_id', '=', actor.orgId)
        .where('recipient_account_id', '=', actor.accountId)
        .where('status', '=', 'pending')
        .execute(),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.notification_type).toBe('schedule.changed');
    expect(batches[0]?.emit_after.getTime()).toBeGreaterThan(
      Date.now() + 14 * 60 * 1000,
    );
    const changes = batches[0]?.changes as Array<{
      eventId: string;
      title: string;
      change: string;
    }>;
    expect(changes).toEqual([
      expect.objectContaining({
        eventId,
        title: updatedTitle,
        change: 'updated',
      }),
    ]);

    const toolsSection = page.locator(
      'section[aria-labelledby="schedule-tools-heading"]',
    );
    const exportForm = toolsSection.locator('form').nth(1);
    await exportForm.getByLabel('Export scope').selectOption('program');
    await exportForm.getByLabel('Scope ID *').fill(program.programId);
    await exportForm.getByLabel('From date *').fill(utcDateInput(startsAt));
    await exportForm.getByLabel('To date *').fill(utcDateInput(startsAt));
    const exportResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/schedule.csv?'),
    );
    await exportForm.getByRole('button', { name: 'Export CSV' }).click();
    const csvResponse = await exportResponse;
    expect(csvResponse.ok()).toBe(true);
    const csv = await csvResponse.text();
    expect(csv).toContain('event_id,title,kind,starts_at,ends_at,timezone');
    expect(csv).toContain(updatedTitle);
    expect(csv).toContain(away.teamSeasonId);
    expect(csv).toContain(home.teamSeasonId);

    const importCsv = [
      'title,kind,starts_at,ends_at,timezone,program_id,division_id',
      `Imported schedule acceptance practice,practice,${importStartsAt.toISOString()},${importEndsAt.toISOString()},${timezone},${program.programId},${program.divisionId}`,
    ].join('\n');
    const importForm = toolsSection.locator('form').first();
    await importForm.getByLabel('CSV file *').setInputFiles({
      name: 'schedule-acceptance.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(importCsv),
    });
    const importResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/schedule.csv/import'),
    );
    await importForm.getByRole('button', { name: 'Validate import' }).click();
    const importQueued = await importResponse;
    if (!importQueued.ok())
      throw new Error(
        `Import request failed (${String(importQueued.status())}): ${await importQueued.text()}`,
      );
    await expect(toolsSection.getByText('ready', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      toolsSection.getByText('1 rows can be imported.'),
    ).toBeVisible();
    await toolsSection.getByRole('button', { name: 'Commit import' }).click();
    await expect(page.getByRole('status')).toHaveText('Import committed.');

    const requestDetails = editDetails
      .locator('details')
      .filter({ hasText: 'Request a reschedule' });
    await requestDetails
      .getByText('Request a reschedule', { exact: true })
      .click();
    const requestForm = requestDetails.locator('form');
    await requestForm
      .getByLabel('Reason *')
      .fill('Field maintenance requires a different game time.');
    await requestForm
      .getByLabel('Proposed start (event timezone) *')
      .fill(localInput(proposedStartsAt));
    await requestForm
      .getByLabel('Proposed end (event timezone) *')
      .fill(localInput(proposedEndsAt));
    await requestForm
      .getByRole('button', { name: 'Send reschedule request' })
      .click();
    await expect(page.getByRole('status')).toHaveText(
      'Reschedule request submitted.',
    );
    const requestsPanel = page.locator(
      'section[aria-labelledby="schedule-requests-heading"]',
    );
    await requestsPanel
      .getByRole('button', { name: 'Refresh requests' })
      .click();
    const requestCard = requestsPanel
      .locator('article')
      .filter({ hasText: updatedTitle });
    await expect(requestCard).toBeVisible();
    await requestCard
      .getByRole('button', { name: 'Approve proposed slot' })
      .click();
    await expect(requestCard).toBeHidden();

    const finalEvents = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('events')
        .select(['title', 'starts_at', 'published'])
        .where('org_id', '=', actor.orgId)
        .where('id', 'in', [eventId])
        .execute(),
    );
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0]?.title).toBe(updatedTitle);
    expect(finalEvents[0]?.published).toBe(true);
    expect(finalEvents[0]?.starts_at.getTime()).toBe(
      proposedStartsAt.getTime(),
    );
    const imported = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('events')
        .select(['title', 'published'])
        .where('org_id', '=', actor.orgId)
        .where('title', '=', 'Imported schedule acceptance practice')
        .execute(),
    );
    expect(imported).toEqual([
      { title: 'Imported schedule acceptance practice', published: false },
    ]);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
