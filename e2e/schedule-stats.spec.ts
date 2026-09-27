import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { emitPendingScheduleBatches } from '../server/src/modules/scheduling/generator';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test.use({ timezoneId: 'UTC' });

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
    const closurePersonId = await factories.person(actor, {
      firstName: 'North',
      lastName: 'Park Volunteer',
      dateOfBirth: '1988-06-12',
    });
    const closureHouseholdId = await factories.household(actor);
    const facilityId = newId();
    const spaceId = newId();
    const volunteerRoleId = newId();
    const eventId = newId();
    const closureEventIds = Array.from({ length: 24 }, () => newId());
    const volunteerShiftIds = closureEventIds.map(() => newId());
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
          public: true,
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
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: actor.orgId,
          person_id: closurePersonId,
          account_id: actor.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('volunteer_roles')
        .values({
          id: volunteerRoleId,
          org_id: actor.orgId,
          name: 'North Park field volunteer',
          minimum_age: 18,
          created_by: actor.accountId,
        })
        .execute();
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
        .values(
          closureEventIds.map((id, index) => ({
            id,
            org_id: actor.orgId,
            program_id: program.programId,
            division_id: program.divisionId,
            kind: 'game' as const,
            title: `North Park rainout game ${String(index + 1)}`,
            starts_at: closureEventStartsAt,
            ends_at: closureEventEndsAt,
            timezone: 'America/Chicago',
            space_id: spaceId,
            published: true,
          })),
        )
        .execute();
      await trx
        .insertInto('volunteer_shifts')
        .values(
          closureEventIds.map((eventId, index) => ({
            id: volunteerShiftIds[index] ?? newId(),
            org_id: actor.orgId,
            volunteer_role_id: volunteerRoleId,
            event_id: eventId,
            facility_id: facilityId,
            starts_at: closureEventStartsAt,
            ends_at: closureEventEndsAt,
            slots: 1,
            credit_hours: 1,
            created_by: actor.accountId,
          })),
        )
        .execute();
      await trx
        .insertInto('volunteer_signups')
        .values(
          volunteerShiftIds.map((volunteerShiftId) => ({
            id: newId(),
            org_id: actor.orgId,
            volunteer_shift_id: volunteerShiftId,
            person_id: closurePersonId,
            household_id: closureHouseholdId,
            status: 'confirmed',
            created_by: actor.accountId,
          })),
        )
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
    const contestId = await createWithOrg(database)(
      actor,
      async (trx) =>
        (
          await trx
            .selectFrom('contests')
            .select('id')
            .where('org_id', '=', actor.orgId)
            .where('event_id', '=', eventId)
            .executeTakeFirstOrThrow()
        ).id,
    );
    const organization = await database
      .selectFrom('organizations')
      .select('slug')
      .where('id', '=', actor.orgId)
      .executeTakeFirstOrThrow();
    const livePage = await page.context().newPage();
    await livePage.goto(
      `/orgs/${organization.slug}/contests/${contestId}/live`,
    );
    await expect(
      livePage.getByRole('heading', { name: 'Live score' }),
    ).toBeVisible();
    await expect(livePage.getByRole('status')).toHaveText(
      'Live score updates connected.',
    );
    await expect(
      livePage.getByText('scheduled', { exact: true }),
    ).toBeVisible();
    await page.getByLabel(`Goals for ${home.teamSeasonId}`).fill('3');
    await page.getByLabel(`Goals for ${away.teamSeasonId}`).fill('1');
    await page
      .getByLabel('Format-specific result JSON')
      .fill('{"home":2,"away":1}');
    await page.getByLabel('Finalize result and update standings').check();
    await page.getByRole('button', { name: 'Submit result' }).click();
    await expect(page.getByRole('status')).toHaveText('Result submitted.');
    const liveScoreboard = livePage.getByRole('region', {
      name: 'Live scoreboard',
    });
    await expect(livePage.getByText('final', { exact: true })).toBeVisible();
    await expect(liveScoreboard.getByText('2', { exact: true })).toBeVisible();
    await expect(liveScoreboard.getByText('1', { exact: true })).toBeVisible();
    expect(await accessibilityViolations(livePage)).toEqual([]);
    await livePage.close();
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
    await closureForm.getByLabel('Closure scope').selectOption('org');
    await closureForm
      .getByLabel('Starts')
      .fill(zonedInputValue(closureStartsAt, 'America/Chicago'));
    await closureForm
      .getByLabel('Ends')
      .fill(zonedInputValue(closureEndsAt, 'America/Chicago'));
    const orgPreviewRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        request.url().endsWith('/closures/preview'),
    );
    const orgPreviewResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/closures/preview'),
    );
    page.once('dialog', async (dialog) => {
      await dialog.dismiss();
    });
    await closureForm
      .getByRole('button', { name: 'Preview and close' })
      .click();
    const [orgPreview, orgPreviewResult] = await Promise.all([
      orgPreviewRequest,
      orgPreviewResponse,
    ]);
    const orgPreviewBody = orgPreview.postDataJSON() as {
      startsAt: string;
      endsAt: string;
    };
    expect(new Date(orgPreviewBody.startsAt).getTime()).toBe(
      closureStartsAt.getTime(),
    );
    expect(new Date(orgPreviewBody.endsAt).getTime()).toBe(
      closureEndsAt.getTime(),
    );
    expect(await orgPreviewResult.json()).toMatchObject({ count: 24 });

    await closureForm.getByLabel('Closure scope').selectOption('space');
    await closureForm.getByLabel('Facility or space ID').fill(spaceId);
    const spacePreviewRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        request.url().endsWith('/closures/preview'),
    );
    const spacePreviewResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/closures/preview'),
    );
    page.once('dialog', async (dialog) => {
      await dialog.dismiss();
    });
    await closureForm
      .getByRole('button', { name: 'Preview and close' })
      .click();
    const [spacePreview, spacePreviewResult] = await Promise.all([
      spacePreviewRequest,
      spacePreviewResponse,
    ]);
    const spacePreviewBody = spacePreview.postDataJSON() as {
      startsAt: string;
      endsAt: string;
    };
    expect(new Date(spacePreviewBody.startsAt).getTime()).toBe(
      closureStartsAt.getTime(),
    );
    expect(new Date(spacePreviewBody.endsAt).getTime()).toBe(
      closureEndsAt.getTime(),
    );
    expect(await spacePreviewResult.json()).toMatchObject({ count: 24 });

    await closureForm.getByLabel('Closure scope').selectOption('facility');
    await closureForm.getByLabel('Facility or space ID').fill(facilityId);
    await closureForm
      .getByLabel('Starts')
      .fill(zonedInputValue(closureStartsAt, 'America/Chicago'));
    await closureForm
      .getByLabel('Ends')
      .fill(zonedInputValue(closureEndsAt, 'America/Chicago'));
    await closureForm.getByLabel('Reason').selectOption('weather');
    await closureForm
      .getByLabel('Portal message')
      .fill('North Park fields closed due to heavy rain.');
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
    expect(closureDialog).toContain('postpone 24 affected events');
    const closedEvents = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('events')
        .select(['status', 'status_reason'])
        .where('org_id', '=', actor.orgId)
        .where('id', 'in', closureEventIds)
        .execute(),
    );
    expect(closedEvents).toHaveLength(24);
    expect(
      closedEvents.every(
        (event) =>
          event.status === 'postponed' &&
          /^closure:/.test(event.status_reason ?? ''),
      ),
    ).toBe(true);
    const emergencyBatch = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('schedule_change_batches')
        .select(['id', 'changes', 'emit_after', 'notification_type'])
        .where('org_id', '=', actor.orgId)
        .where('recipient_account_id', '=', actor.accountId)
        .execute(),
    );
    expect(emergencyBatch).toHaveLength(1);
    expect(emergencyBatch[0]?.notification_type).toBe('safety.emergency');
    expect(emergencyBatch[0]?.emit_after.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    expect(emergencyBatch[0]?.changes).toHaveLength(24);
    for (const eventId of closureEventIds) {
      expect(emergencyBatch[0]?.changes).toContainEqual(
        expect.objectContaining({ eventId }),
      );
    }
    await emitPendingScheduleBatches(database);
    const emergencyNotice = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('notifications')
        .select(['type', 'payload', 'delivered_channels'])
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .where('type', '=', 'safety.emergency')
        .executeTakeFirstOrThrow(),
    );
    expect(emergencyNotice.delivered_channels).toEqual(['in_app']);
    expect(emergencyNotice.payload).toMatchObject({
      resourceType: 'schedule_change_batch',
      resourceId: emergencyBatch[0]?.id,
      href: '/me/schedule',
    });
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.goto(`/orgs/${organization.slug}/facilities/${facilityId}`);
    await expect(
      page.getByRole('heading', { name: 'North Park Fields' }),
    ).toBeVisible();
    const closureNotices = page.getByRole('region', {
      name: 'Facility closures',
    });
    await expect(closureNotices).toContainText('weather');
    await expect(closureNotices).toContainText(
      'North Park fields closed due to heavy rain.',
    );
    const publicEvents = page.getByRole('table').getByRole('row');
    await expect(publicEvents.filter({ hasText: 'postponed' })).toHaveCount(24);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
