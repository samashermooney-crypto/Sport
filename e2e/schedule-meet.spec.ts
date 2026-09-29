import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';
import { builtInSportTemplatesByKey } from '@shared/sport/templates';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');
const MEET_EVENTS = [
  '25_free',
  '50_free',
  '100_free',
  '200_free',
  '50_back',
  '50_breast',
] as const;

test('meet director seeds and finalizes six events for forty swimmers', async ({
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
    const swimmer = builtInSportTemplatesByKey.get('swimming');
    if (!swimmer) throw new Error('Swimming sport profile is unavailable.');
    const swimmingProfileId = newId();
    const personIds = Array.from({ length: 40 }, () => newId()).sort();
    const eventIds = MEET_EVENTS.map(() => newId());
    const firstEventStartsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    firstEventStartsAt.setMinutes(0, 0, 0);

    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
      await trx
        .insertInto('sport_profiles')
        .values({
          id: swimmingProfileId,
          org_id: actor.orgId,
          name: 'Swimming',
          profile: swimmer,
        })
        .execute();
      await trx
        .updateTable('programs')
        .set({ sport_profile_id: swimmingProfileId })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('teams')
        .set({ sport_profile_id: swimmingProfileId })
        .where('org_id', '=', actor.orgId)
        .where('id', 'in', [home.teamId, away.teamId])
        .execute();
      await trx
        .insertInto('people')
        .values(
          personIds.map((id, index) => ({
            id,
            org_id: actor.orgId,
            first_name: `Swimmer${String(index + 1).padStart(2, '0')}`,
            last_name: 'Meet',
            date_of_birth: '2012-01-01',
          })),
        )
        .execute();
      await trx
        .insertInto('roster_entries')
        .values(
          personIds.map((personId, index) => ({
            id: newId(),
            org_id: actor.orgId,
            team_season_id:
              index % 2 === 0 ? home.teamSeasonId : away.teamSeasonId,
            person_id: personId,
          })),
        )
        .execute();
      for (const [eventIndex, eventId] of eventIds.entries()) {
        const startsAt = new Date(
          firstEventStartsAt.getTime() + eventIndex * 60 * 60 * 1000,
        );
        await trx
          .insertInto('events')
          .values({
            id: eventId,
            org_id: actor.orgId,
            program_id: program.programId,
            division_id: program.divisionId,
            kind: 'meet',
            title: `Swim ${MEET_EVENTS[eventIndex] ?? 'event'}`,
            starts_at: startsAt,
            ends_at: new Date(startsAt.getTime() + 45 * 60 * 1000),
            timezone: 'America/Chicago',
          })
          .execute();
        await trx
          .insertInto('event_participants')
          .values(
            personIds.map((personId) => ({
              id: newId(),
              org_id: actor.orgId,
              event_id: eventId,
              person_id: personId,
            })),
          )
          .execute();
      }
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
    await page.getByLabel('Program *').selectOption(program.programId);
    const selectedEvent = page.getByLabel('Selected event');
    const teamPoints = new Map<string, number>();

    for (const [eventIndex, eventId] of eventIds.entries()) {
      const title = `Swim ${MEET_EVENTS[eventIndex] ?? 'event'}`;
      await expect(
        selectedEvent.getByRole('option', { name: title }),
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
      const createResult = await createResponse;
      expect(createResult.ok()).toBe(true);
      const created = (await createResult.json()) as { id: string };

      await expect(
        page.getByRole('button', { name: 'Save meet assignments' }),
      ).toBeVisible();
      const participants = await createWithOrg(database)(actor, (trx) =>
        trx
          .selectFrom('contest_participants')
          .select(['id', 'person_id'])
          .where('org_id', '=', actor.orgId)
          .where('contest_id', '=', created.id)
          .orderBy('person_id')
          .execute(),
      );
      expect(participants).toHaveLength(40);
      for (const [index, participant] of participants.entries()) {
        const personId = participant.person_id;
        if (!personId) throw new Error('Swim entrant person is missing.');
        const seed = index + 1;
        const heat = 5 - Math.floor(index / 8);
        const lane = (index % 8) + 1;
        await expect(page.getByLabel(`Seed for ${personId}`)).toHaveValue(
          String(seed),
        );
        await expect(page.getByLabel(`Heat for ${personId}`)).toHaveValue(
          String(heat),
        );
        await expect(page.getByLabel(`Lane for ${personId}`)).toHaveValue(
          String(lane),
        );
      }
      const assignmentsResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          response.url().endsWith(`/contests/${created.id}/meet-assignments`),
      );
      await page.getByRole('button', { name: 'Save meet assignments' }).click();
      expect((await assignmentsResponse).ok()).toBe(true);

      const entries = participants.map((participant, index) => ({
        participantId: participant.id,
        value:
          30_000 +
          index * 250 +
          eventIndex * 10 +
          (eventIndex === 0 && index === 2 ? -250 : 0),
      }));
      await page
        .getByLabel('Format-specific result JSON')
        .fill(JSON.stringify({ entries }));
      const finalizeResult = page.getByLabel(
        'Finalize result and update standings',
      );
      await finalizeResult.check();
      await expect(finalizeResult).toBeChecked();
      const resultResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith(`/contests/${created.id}/results`),
      );
      await page.getByRole('button', { name: 'Submit result' }).click();
      const result = await resultResponse;
      expect(result.ok()).toBe(true);
      expect(((await result.json()) as { status: string }).status).toBe(
        'final',
      );

      const rows = await createWithOrg(database)(actor, (trx) =>
        trx
          .selectFrom('contest_results')
          .innerJoin('contest_participants', (join) =>
            join
              .onRef(
                'contest_participants.org_id',
                '=',
                'contest_results.org_id',
              )
              .onRef(
                'contest_participants.id',
                '=',
                'contest_results.contest_participant_id',
              ),
          )
          .select([
            'contest_participants.person_id',
            'contest_results.place',
            'contest_results.points_awarded',
          ])
          .where('contest_results.org_id', '=', actor.orgId)
          .where('contest_participants.contest_id', '=', created.id)
          .orderBy('contest_participants.person_id')
          .execute(),
      );
      expect(rows).toHaveLength(40);
      for (const row of rows) {
        const personIndex = personIds.indexOf(row.person_id ?? '');
        const teamSeasonId =
          personIndex % 2 === 0 ? home.teamSeasonId : away.teamSeasonId;
        teamPoints.set(
          teamSeasonId,
          (teamPoints.get(teamSeasonId) ?? 0) +
            Number.parseInt(String(row.points_awarded ?? 0), 10),
        );
      }
      if (eventIndex === 0) {
        const tiePlaces = rows
          .filter((row) =>
            [personIds[1], personIds[2]].includes(row.person_id ?? ''),
          )
          .map((row) => row.place);
        expect(tiePlaces).toEqual([2, 2]);
      }
    }

    expect(teamPoints.get(home.teamSeasonId)).toBe(61);
    expect(teamPoints.get(away.teamSeasonId)).toBe(36);
    expect(await accessibilityViolations(page)).toEqual([]);
  } finally {
    await database.destroy();
  }
});
