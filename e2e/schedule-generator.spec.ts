import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');
const dayMilliseconds = 24 * 60 * 60 * 1000;

function upcomingSaturday(): string {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const daysUntilSaturday = (6 - start.getUTCDay() + 7) % 7 || 7;
  start.setUTCDate(start.getUTCDate() + daysUntilSaturday);
  return start.toISOString().slice(0, 10);
}

function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setTime(date.getTime() + count * dayMilliseconds);
  return date.toISOString().slice(0, 10);
}

test('staff reviews generator explanations, discards, then applies a draft', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const teams = await Promise.all([
      factories.team(actor, program),
      factories.team(actor, program),
    ]);
    const facilityId = newId();
    const spaceId = newId();
    const seasonStartsOn = upcomingSaturday();
    const seasonEndsOn = addDays(seasonStartsOn, 14);

    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('seasons')
        .set({ starts_on: seasonStartsOn, ends_on: seasonEndsOn })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.seasonId)
        .execute();
      await trx
        .updateTable('programs')
        .set({ starts_on: seasonStartsOn, ends_on: seasonEndsOn })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
      await trx
        .updateTable('team_seasons')
        .set({ status: 'active' })
        .where('org_id', '=', actor.orgId)
        .where(
          'id',
          'in',
          teams.map((team) => team.teamSeasonId),
        )
        .execute();
      await trx
        .insertInto('facilities')
        .values({
          id: facilityId,
          org_id: actor.orgId,
          name: 'Generator Acceptance Park',
          ownership: 'owned',
          timezone: 'America/Chicago',
        })
        .execute();
      await trx
        .insertInto('spaces')
        .values({
          id: spaceId,
          org_id: actor.orgId,
          facility_id: facilityId,
          name: 'Generator Acceptance Field',
          kind: 'field',
          suitability: { sportProfileIds: [program.sportProfileId] },
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

    await page.goto(`/console/orgs/${actor.orgId}/schedule`);
    const generator = page.getByRole('region', { name: 'Schedule generator' });
    const form = generator.locator('form');
    await form.getByLabel('Program *').selectOption(program.programId);
    const division = form.getByLabel('Division *');
    await expect(division).toBeEnabled();
    await division.selectOption(program.divisionId);
    await expect(division).toHaveValue(program.divisionId);
    await form.getByLabel('Season starts *').fill(seasonStartsOn);
    await form.getByLabel('Season ends *').fill(seasonEndsOn);
    await form.getByLabel('Games per team *').fill('1');
    const generate = async () => {
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' &&
          candidate.url().includes('/generation-runs'),
      );
      await form.getByRole('button', { name: 'Generate draft' }).click();
      const result = await response;
      if (!result.ok())
        throw new Error(
          `Generator request failed (${String(result.status())}): ${await result.text()}`,
        );
    };

    await generate();
    await expect(generator.getByText('succeeded', { exact: true })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await expect(
      generator.getByRole('heading', { name: 'Unscheduled games' }),
    ).toBeVisible();
    await expect(
      generator.getByText(/No suitable space and time window remains/),
    ).toBeVisible();
    await generator.getByRole('button', { name: 'Discard' }).click();
    await expect(
      generator.getByText('discarded', { exact: true }),
    ).toBeVisible();

    await createWithOrg(database)(actor, (trx) =>
      trx
        .insertInto('space_availability')
        .values({
          id: newId(),
          org_id: actor.orgId,
          space_id: spaceId,
          recurrence: {
            kind: 'weekly',
            interval: 1,
            byDay: ['SA'],
            startsOn: seasonStartsOn,
            endsOn: seasonEndsOn,
          },
          starts_on: seasonStartsOn,
          ends_on: seasonEndsOn,
          start_time: '08:00',
          end_time: '18:00',
          source: 'owned',
        })
        .execute()
        .then(() => undefined),
    );

    await generate();
    await expect(generator.getByText('succeeded', { exact: true })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await expect(
      generator.getByText('All requested games were placed.'),
    ).toBeVisible();
    await generator.getByRole('button', { name: 'Apply draft' }).click();
    await expect(
      page.getByText('Generated schedule applied.', { exact: true }),
    ).toBeVisible();

    const runs = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('schedule_generation_runs')
        .select(['status', 'result'])
        .where('org_id', '=', actor.orgId)
        .where('program_id', '=', program.programId)
        .orderBy('created_at', 'asc')
        .execute(),
    );
    expect(runs.map((run) => run.status)).toEqual(['discarded', 'applied']);
    const explanation = runs[0]?.result as {
      unscheduled?: { reasons: string[] }[];
    } | null;
    expect(explanation?.unscheduled).toHaveLength(1);
    expect(explanation?.unscheduled?.[0]?.reasons).toContain(
      'No suitable space and time window remains after availability and blackouts.',
    );
    const appliedResult = runs[1]?.result as {
      draftEvents?: unknown[];
    } | null;
    expect(appliedResult?.draftEvents).toHaveLength(1);
    const generatedEvents = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('events')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('program_id', '=', program.programId)
        .where('kind', '=', 'game')
        .execute(),
    );
    expect(generatedEvents).toHaveLength(1);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
