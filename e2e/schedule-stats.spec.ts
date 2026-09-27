import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

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

test('staff configures statistics, finalizes a game, closes a facility, and opens its leaderboard', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const home = await factories.team(actor, program);
    const away = await factories.team(actor, program);
    const facilityId = newId();
    const spaceId = newId();
    const closureEventId = newId();
    const closureEventStartsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    closureEventStartsAt.setSeconds(0, 0);
    const closureEventEndsAt = new Date(
      closureEventStartsAt.getTime() + 60 * 60 * 1000,
    );
    const closureStartsAt = new Date(
      closureEventStartsAt.getTime() - 60 * 60 * 1000,
    );
    const closureEndsAt = new Date(
      closureEventEndsAt.getTime() + 60 * 60 * 1000,
    );
    const profile = {
      ...builtInSportTemplates[0],
      stats: [
        {
          key: 'goals',
          label: { en: 'Goals', es: 'Goles' },
          abbreviation: 'G',
          level: 'team' as const,
          valueType: 'integer' as const,
          aggregate: 'sum' as const,
          public: true,
        },
        {
          key: 'private_mark',
          label: { en: 'Private mark', es: 'Marca privada' },
          abbreviation: 'PM',
          level: 'athlete' as const,
          valueType: 'decimal' as const,
          aggregate: 'max' as const,
          public: false,
        },
      ],
    };
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
      await trx
        .updateTable('sport_profiles')
        .set({ profile })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.sportProfileId)
        .execute();
      await trx
        .updateTable('programs')
        .set({ settings: { statsEnabled: [] } })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('teams')
        .set({ name: 'Northside' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', home.teamId)
        .execute();
      await trx
        .updateTable('teams')
        .set({ name: 'Southside' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', away.teamId)
        .execute();
      await trx
        .insertInto('facilities')
        .values({
          id: facilityId,
          org_id: actor.orgId,
          name: 'North Park Fields',
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
          name: 'North Park Field 1',
          kind: 'field',
          suitability: { sportProfileIds: [program.sportProfileId] },
        })
        .execute();
      const eventId = newId();
      const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await trx
        .insertInto('events')
        .values({
          id: eventId,
          org_id: actor.orgId,
          program_id: program.programId,
          division_id: program.divisionId,
          kind: 'game',
          title: 'Statistics acceptance match',
          starts_at: startsAt,
          ends_at: new Date(startsAt.getTime() + 60 * 60 * 1000),
          timezone: 'America/Chicago',
          published: true,
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
      await trx
        .insertInto('events')
        .values({
          id: closureEventId,
          org_id: actor.orgId,
          program_id: program.programId,
          division_id: program.divisionId,
          kind: 'game',
          title: 'Rainout closure game',
          starts_at: closureEventStartsAt,
          ends_at: closureEventEndsAt,
          timezone: 'America/Chicago',
          space_id: spaceId,
          published: true,
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
    await page
      .getByRole('textbox', { name: 'Program ID *' })
      .fill(program.programId);
    await page.getByRole('button', { name: 'Load statistic settings' }).click();
    await expect(page.getByLabel('Goals (team) · public')).toBeVisible();
    await expect(
      page.getByLabel('Private mark (athlete) · staff only'),
    ).toBeVisible();
    await page.getByLabel('Goals (team) · public').check();
    const saveStats = page.getByRole('button', {
      name: 'Save statistic settings',
    });
    await saveStats.click();
    await expect(saveStats).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByRole('status')).toHaveText(
      'Program statistics settings saved.',
    );
    await page
      .getByRole('button', { name: 'Create contest · first sport format' })
      .click();
    await expect(
      page.getByText(/head_to_head_score|head-to-head-score/i),
    ).toBeVisible();
    await page.getByLabel(`Goals for ${home.teamSeasonId}`).fill('3');
    await page.getByLabel(`Goals for ${away.teamSeasonId}`).fill('1');
    await page
      .getByLabel('Format-specific result JSON')
      .fill('{"home":2,"away":1}');
    await page.getByLabel('Finalize result and update standings').check();
    await page.getByRole('button', { name: 'Submit result' }).click();
    await expect(page.getByRole('status')).toHaveText('Result submitted.');
    const savedStats = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('stat_lines')
        .select(['team_season_id', 'stat_key', 'value'])
        .where('org_id', '=', actor.orgId)
        .where('stat_key', '=', 'goals')
        .orderBy('team_season_id')
        .execute(),
    );
    expect(
      Object.fromEntries(
        savedStats.map((row) => [row.team_season_id, row.value]),
      ),
    ).toEqual({
      [home.teamSeasonId]: '3',
      [away.teamSeasonId]: '1',
    });
    await page.getByRole('button', { name: 'Load leaderboards' }).click();
    await expect(page.getByRole('heading', { name: 'Goals' })).toBeVisible();
    await expect(
      page.getByRole('cell', { name: '3', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Load standings' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Standings snapshot loaded.',
    );
    const standingsRegion = page.getByRole('region', { name: 'Standings' });
    await expect(
      standingsRegion.getByRole('rowheader', { name: 'Northside' }),
    ).toBeVisible();
    await expect(
      standingsRegion.getByRole('rowheader', { name: 'Southside' }),
    ).toBeVisible();
    const snapshot = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('standings_snapshots')
        .select('rows')
        .where('org_id', '=', actor.orgId)
        .where('scope_type', '=', 'program')
        .where('scope_id', '=', program.programId)
        .orderBy('computed_at', 'desc')
        .executeTakeFirst(),
    );
    expect(snapshot?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          teamId: home.teamSeasonId,
          played: 1,
          wins: 1,
          scored: 2,
          allowed: 1,
        }),
        expect.objectContaining({
          teamId: away.teamSeasonId,
          played: 1,
          losses: 1,
          scored: 1,
          allowed: 2,
        }),
      ]),
    );
    const closureForm = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Preview and close' }) });
    await closureForm.getByLabel('Closure scope').selectOption('facility');
    await closureForm.getByLabel('Facility or space ID').fill(facilityId);
    await closureForm
      .getByLabel('Starts')
      .fill(zonedInputValue(closureStartsAt, 'America/Chicago'));
    await closureForm
      .getByLabel('Ends')
      .fill(zonedInputValue(closureEndsAt, 'America/Chicago'));
    await closureForm.getByLabel('Reason').selectOption('weather');
    let closureDialog = '';
    page.once('dialog', async (dialog) => {
      closureDialog = dialog.message();
      await dialog.accept();
    });
    await closureForm
      .getByRole('button', { name: 'Preview and close' })
      .click();
    await expect(page.getByRole('status')).toHaveText(
      'Closure recorded and affected events updated.',
    );
    expect(closureDialog).toContain('postpone 1 affected events');
    const closedEvent = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('events')
        .select(['status', 'status_reason'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', closureEventId)
        .executeTakeFirstOrThrow(),
    );
    expect(closedEvent.status).toBe('postponed');
    expect(closedEvent.status_reason).toMatch(/^closure:/);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
