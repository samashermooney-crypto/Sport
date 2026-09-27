import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

function dateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

test('scheduler crews ten games and officials respond to offers and pay totals match', async ({
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
    const home = await factories.team(actor, program);
    const away = await factories.team(actor, program);
    const positions = [
      { key: 'referee', name: 'Referee' },
      { key: 'ar1', name: 'Assistant Referee 1' },
      { key: 'ar2', name: 'Assistant Referee 2' },
    ];
    const crew = [
      { key: 'referee', feeCents: 6_000 },
      { key: 'ar1', feeCents: 4_000 },
      { key: 'ar2', feeCents: 3_500 },
      { key: 'ar2', feeCents: 3_000 },
    ];
    const officials: Array<{ personId: string; accountId: string }> = [];
    for (const [index, member] of crew.entries()) {
      const personId = await factories.person(actor, {
        firstName: `Official${String(index + 1)}`,
        lastName: 'Crew',
        dateOfBirth: '1990-01-01',
      });
      const accountId = newId();
      await database
        .insertInto('accounts')
        .values({
          id: accountId,
          email: `official-${accountId}@example.invalid`,
          first_name: `Official${String(index + 1)}`,
          last_name: 'Crew',
          date_of_birth: '1990-01-01',
          email_verified_at: new Date(),
        })
        .execute();
      await createWithOrg(database)(actor, async (trx) => {
        await trx
          .insertInto('org_memberships')
          .values({
            id: newId(),
            org_id: actor.orgId,
            account_id: accountId,
            status: 'active',
            joined_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('person_account_links')
          .values({
            id: newId(),
            org_id: actor.orgId,
            person_id: personId,
            account_id: accountId,
            relationship: 'self',
            verified_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('official_profiles')
          .values({
            id: newId(),
            org_id: actor.orgId,
            person_id: personId,
            sports: [program.sportProfileId],
            pay_rates: {
              [member.key]: { feeCents: member.feeCents },
            },
          })
          .execute();
      });
      officials.push({ personId, accountId });
    }

    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
      for (const [index, position] of positions.entries()) {
        await trx
          .insertInto('official_positions')
          .values({
            id: newId(),
            org_id: actor.orgId,
            sport_profile_id: program.sportProfileId,
            key: position.key,
            name: position.name,
            sort_order: index,
          })
          .execute();
      }
    });

    const firstGame = new Date();
    firstGame.setUTCDate(firstGame.getUTCDate() - 3);
    firstGame.setUTCHours(14, 0, 0, 0);
    const eventIds: string[] = [];
    const contestIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const day = new Date(firstGame);
      day.setUTCDate(day.getUTCDate() + Math.floor(index / 5));
      day.setUTCHours(14 + (index % 5), 0, 0, 0);
      const eventId = newId();
      await createWithOrg(database)(actor, async (trx) => {
        await trx
          .insertInto('events')
          .values({
            id: eventId,
            org_id: actor.orgId,
            program_id: program.programId,
            division_id: program.divisionId,
            kind: 'game',
            title: `Officials Game ${String(index + 1)}`,
            starts_at: day,
            ends_at: new Date(day.getTime() + 60 * 60 * 1000),
            timezone: 'America/Chicago',
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
              side: 'home',
            },
            {
              id: newId(),
              org_id: actor.orgId,
              event_id: eventId,
              team_season_id: away.teamSeasonId,
              side: 'away',
            },
          ])
          .execute();
      });
      eventIds.push(eventId);
    }

    const session = async (accountId: string): Promise<string> =>
      database
        .transaction()
        .execute((trx) =>
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
        )
        .then((value) => value.token);
    const ownerSession = await session(actor.accountId);
    const baseURL = String(testInfo.project.use.baseURL);
    const setSession = async (token: string): Promise<void> => {
      await page.context().addCookies([
        {
          name: '__Host-athlentry_session',
          value: token,
          url: baseURL,
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    };
    await setSession(ownerSession);
    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    const generator = page.locator(
      'section[aria-labelledby="schedule-generator-heading"]',
    );
    await generator.getByLabel('Program ID *').fill(program.programId);
    const selectedEvent = page.getByLabel('Selected event');
    for (const [index, eventId] of eventIds.entries()) {
      const title = `Officials Game ${String(index + 1)}`;
      await expect(
        selectedEvent.getByRole('option', { name: title, exact: true }),
      ).toHaveCount(1);
      await selectedEvent.selectOption(eventId);
      const createResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith(`/events/${eventId}/contests`),
      );
      await page
        .getByRole('button', { name: 'Create contest · first sport format' })
        .click();
      const result = await createResponse;
      expect(result.ok()).toBe(true);
      contestIds.push(((await result.json()) as { id: string }).id);
    }
    const officialsPanel = page.locator(
      'section[aria-labelledby="officials-heading"]',
    );
    const boardForm = officialsPanel.locator('form').nth(0);
    const boardResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/assignment-board?'),
    );
    await boardForm.getByLabel('Board from').fill(dateInput(firstGame));
    const lastGame = new Date(firstGame);
    lastGame.setUTCDate(lastGame.getUTCDate() + 2);
    await boardForm.getByLabel('Board to').fill(dateInput(lastGame));
    await boardForm
      .getByRole('button', { name: 'Load assignment board' })
      .click();
    const boardResult = await boardResponse;
    expect(boardResult.ok()).toBe(true);
    await expect(officialsPanel.locator('pre.schedule-json')).toContainText(
      'Officials Game 10',
    );

    const assignments = new Map<
      string,
      { id: string; version: number; personIndex: number; contestIndex: number }
    >();
    const assignmentForm = officialsPanel.locator('form').nth(1);
    const offer = async (
      contestIndex: number,
      personIndex: number,
      positionKey: string,
      mileageCents: number,
    ): Promise<void> => {
      const contestId = contestIds[contestIndex];
      const official = officials[personIndex];
      if (!contestId || !official)
        throw new Error('Assignment fixture missing.');
      await assignmentForm.getByLabel('Contest ID').fill(contestId);
      await assignmentForm
        .getByLabel('Official person ID')
        .fill(official.personId);
      await assignmentForm.getByLabel('Position key').fill(positionKey);
      await assignmentForm
        .getByLabel('Travel reimbursement (cents)')
        .fill(String(mileageCents));
      const response = page.waitForResponse(
        (item) =>
          item.request().method() === 'POST' &&
          item
            .url()
            .endsWith('/officials/orgs/' + actor.orgId + '/assignments'),
      );
      await assignmentForm
        .getByRole('button', { name: 'Offer assignment' })
        .click();
      const result = await response;
      expect(result.ok()).toBe(true);
      const record = (await result.json()) as {
        id: string;
        version: number;
        status: string;
      };
      expect(record.status).toBe('offered');
      assignments.set(`${String(contestIndex)}:${positionKey}`, {
        id: record.id,
        version: record.version,
        personIndex,
        contestIndex,
      });
    };

    for (let index = 0; index < contestIds.length; index += 1) {
      await offer(index, 0, 'referee', 500);
      await offer(index, 1, 'ar1', 0);
      await offer(index, 2, 'ar2', 0);
    }

    const respond = async (
      personIndex: number,
      assignment: { id: string },
      gameTitle: string,
      response: 'accepted' | 'declined',
    ): Promise<void> => {
      const official = officials[personIndex];
      if (!official) throw new Error('Official fixture missing.');
      await setSession(await session(official.accountId));
      await page.goto(`/portal/orgs/${actor.orgId}/schedule/officials`);
      const card = page.locator('article').filter({
        has: page.getByRole('heading', {
          name: gameTitle,
          exact: true,
        }),
      });
      await expect(card).toBeVisible();
      const button =
        response === 'accepted' ? 'Accept assignment' : 'Decline assignment';
      const responsePromise = page.waitForResponse(
        (item) =>
          item.request().method() === 'POST' &&
          item.url().endsWith(`/assignments/${assignment.id}/respond`),
      );
      await card.getByRole('button', { name: button }).click();
      const result = await responsePromise;
      expect(result.ok()).toBe(true);
      expect(((await result.json()) as { status: string }).status).toBe(
        response,
      );
    };

    for (let index = 0; index < 10; index += 1) {
      const referee = assignments.get(`${String(index)}:referee`);
      const ar1 = assignments.get(`${String(index)}:ar1`);
      const ar2 = assignments.get(`${String(index)}:ar2`);
      const gameTitle = `Officials Game ${String(index + 1)}`;
      if (!referee || !ar1 || !ar2) throw new Error('Crew fixture missing.');
      if (index === 0) {
        await respond(2, ar2, gameTitle, 'declined');
      } else {
        await respond(2, ar2, gameTitle, 'accepted');
      }
      await respond(0, referee, gameTitle, 'accepted');
      await respond(1, ar1, gameTitle, 'accepted');
    }
    const declinedGame = assignments.get('0:ar2');
    if (!declinedGame) throw new Error('Declined assignment missing.');
    await setSession(ownerSession);
    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    const freshOfficialsPanel = page.locator(
      'section[aria-labelledby="officials-heading"]',
    );
    await offer(0, 3, 'ar2', 0);
    const replacement = assignments.get('0:ar2');
    if (!replacement) throw new Error('Replacement assignment missing.');
    await respond(3, replacement, 'Officials Game 1', 'accepted');
    await expect(
      page.getByRole('heading', { name: 'My officiating schedule' }),
    ).toHaveCount(1);
    await setSession(ownerSession);
    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    const payForm = freshOfficialsPanel.locator('form').nth(2);
    await payForm.getByLabel('Pay period starts').fill(dateInput(firstGame));
    await payForm.getByLabel('Pay period ends').fill(dateInput(lastGame));
    const payBatchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/officials/orgs/${actor.orgId}/pay-batches`),
    );
    await payForm.getByRole('button', { name: 'Draft pay batch' }).click();
    const payBatchResult = await payBatchResponse;
    expect(payBatchResult.ok()).toBe(true);
    const payBatch = (await payBatchResult.json()) as {
      totalCents: number;
      lines: unknown[];
    };
    expect(payBatch.lines).toHaveLength(30);
    expect(payBatch.totalCents).toBe(139_500);
    await expect(freshOfficialsPanel).toContainText(
      'Total: $1395.00 · 30 assignments',
    );
    const firstGameCrew = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('official_assignments')
        .select(['id', 'person_id', 'status'])
        .where('org_id', '=', actor.orgId)
        .where('contest_id', '=', contestIds[0] ?? '')
        .where('position_key', '=', 'ar2')
        .execute(),
    );
    expect(firstGameCrew).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: declinedGame.id, status: 'declined' }),
        expect.objectContaining({
          id: replacement.id,
          person_id: officials[3]?.personId,
          status: 'accepted',
        }),
      ]),
    );
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
