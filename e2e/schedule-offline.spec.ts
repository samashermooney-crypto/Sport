import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('coach syncs offline attendance and surfaces a changed score', async ({
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
    const personId = await factories.person(actor, {
      firstName: 'Jordan',
      lastName: 'Runner',
      dateOfBirth: '2012-05-12',
    });
    const eventId = newId();
    const contestId = newId();
    const homeEventParticipantId = newId();
    const awayEventParticipantId = newId();
    const homeContestParticipantId = newId();
    const awayContestParticipantId = newId();
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
      await trx
        .insertInto('roster_entries')
        .values({
          id: newId(),
          org_id: actor.orgId,
          team_season_id: home.teamSeasonId,
          person_id: personId,
          status: 'active',
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
          title: 'Offline game day',
          starts_at: startsAt,
          ends_at: endsAt,
          timezone: 'America/Chicago',
          published: true,
        })
        .execute();
      await trx
        .insertInto('event_participants')
        .values([
          {
            id: homeEventParticipantId,
            org_id: actor.orgId,
            event_id: eventId,
            team_season_id: home.teamSeasonId,
            side: 'home',
          },
          {
            id: awayEventParticipantId,
            org_id: actor.orgId,
            event_id: eventId,
            team_season_id: away.teamSeasonId,
            side: 'away',
          },
        ])
        .execute();
      await trx
        .insertInto('contests')
        .values({
          id: contestId,
          org_id: actor.orgId,
          event_id: eventId,
          sport_profile_id: program.sportProfileId,
          profile_version: 1,
          format: 'head_to_head_score',
        })
        .execute();
      await trx
        .insertInto('contest_participants')
        .values([
          {
            id: homeContestParticipantId,
            org_id: actor.orgId,
            contest_id: contestId,
            team_season_id: home.teamSeasonId,
            side: 'home',
          },
          {
            id: awayContestParticipantId,
            org_id: actor.orgId,
            contest_id: contestId,
            team_season_id: away.teamSeasonId,
            side: 'away',
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

    await page.goto(
      `/console/orgs/${actor.orgId}/schedule/events/${eventId}/game-day`,
    );
    await expect(page.getByRole('heading', { name: 'Game day' })).toBeVisible();
    const attendance = page.getByLabel('Attendance for Jordan Runner');
    await page.context().setOffline(true);
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
    await attendance.selectOption('present');
    await page
      .getByLabel('Score or meet result JSON')
      .fill('{"home":2,"away":1}');
    await page.getByRole('button', { name: 'Save score offline' }).click();
    await expect(page.getByText('2 pending offline change(s)')).toBeVisible();

    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .insertInto('contest_results')
        .values([
          {
            id: newId(),
            org_id: actor.orgId,
            contest_participant_id: homeContestParticipantId,
            score: 0,
            outcome: 'loss',
          },
          {
            id: newId(),
            org_id: actor.orgId,
            contest_participant_id: awayContestParticipantId,
            score: 1,
            outcome: 'win',
          },
        ])
        .execute();
      await trx
        .updateTable('contests')
        .set({ status: 'in_progress', version: 2 })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', contestId)
        .where('version', '=', 1)
        .execute();
    });
    await page.context().setOffline(false);
    await expect(page.getByRole('alert')).toContainText(
      'The server changed this record while the device was offline.',
    );
    await expect(page.getByText('1 pending offline change(s)')).toBeVisible();
    const queuedActions = await page.evaluate(
      ({ orgId, eventId }) => {
        const saved = sessionStorage.getItem(
          `athlentry:gameday:${orgId}:${eventId}`,
        );
        return saved ? (JSON.parse(saved) as unknown) : [];
      },
      { orgId: actor.orgId, eventId },
    );
    expect(queuedActions).toMatchObject([
      { type: 'result', contestId, expectedVersion: 1 },
    ]);
    const savedAttendance = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('attendance')
        .select('status')
        .where('org_id', '=', actor.orgId)
        .where('event_id', '=', eventId)
        .where('person_id', '=', personId)
        .executeTakeFirstOrThrow(),
    );
    expect(savedAttendance.status).toBe('present');
    const serverResults = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('contest_results')
        .innerJoin('contest_participants', (join) =>
          join
            .onRef('contest_participants.org_id', '=', 'contest_results.org_id')
            .onRef(
              'contest_participants.id',
              '=',
              'contest_results.contest_participant_id',
            ),
        )
        .select(['contest_participants.side', 'contest_results.score'])
        .where('contest_results.org_id', '=', actor.orgId)
        .where('contest_participants.contest_id', '=', contestId)
        .execute(),
    );
    expect(
      Object.fromEntries(serverResults.map((row) => [row.side, row.score])),
    ).toEqual({ home: '0', away: '1' });
    await expect(page.getByRole('alert')).toHaveCount(1);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
