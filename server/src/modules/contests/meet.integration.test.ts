import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplatesByKey } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import {
  assignMeetParticipants,
  createContest,
  listContestResults,
  submitContestResult,
} from './service';

let database: ReturnType<typeof createDatabase>;
type TestActor = OrgContext & { accountId: string };

const LANES = 8;
const PLACE_POINTS = [6, 4, 3, 2, 1];
const ATHLETES = 40;
const MEET_EVENTS = [
  '25_free',
  '50_free',
  '100_free',
  '200_free',
  '50_back',
  '50_breast',
];

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for meet tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});

afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

function expectedPlaces(values: readonly (number | null)[]): (number | null)[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value !== null)
    .sort(
      (a, b) => (a.value as number) - (b.value as number) || a.index - b.index,
    );
  const places = new Map<number, number>();
  order.forEach((entry, position) => {
    const previous = order[position - 1];
    places.set(
      entry.index,
      previous && previous.value === entry.value
        ? (places.get(previous.index) ?? position + 1)
        : position + 1,
    );
  });
  return values.map((_, index) => places.get(index) ?? null);
}

describe('timed meet acceptance', () => {
  it(
    'seeds heats, ranks forty athletes with ties and totals team points',
    { timeout: 60_000 },
    async () => {
      const orgId = newId();
      await database
        .insertInto('organizations')
        .values({
          id: orgId,
          slug: `meet-${randomUUID().slice(0, 12)}`,
          name: 'Meet Acceptance Org',
          kind: 'club',
          timezone: 'America/Chicago',
        })
        .execute();
      const accountId = newId();
      await database
        .insertInto('accounts')
        .values({
          id: accountId,
          email: `meet-${accountId}@example.invalid`,
          first_name: 'Meet',
          last_name: 'Director',
          date_of_birth: '1990-01-01',
          email_verified_at: new Date(),
        })
        .execute();
      const owner: TestActor = { orgId, accountId, actor: { accountId } };
      const withOrg = createWithOrg(database);

      const seasonId = newId();
      const sportProfileId = newId();
      const programId = newId();
      const divisionId = newId();
      const teamSeasonIds = [newId(), newId()];
      const swimmer = builtInSportTemplatesByKey.get('swimming');
      if (!swimmer) throw new Error('Swimming template is unavailable.');
      const format = swimmer.contestFormats[0];
      if (!format || format.format !== 'multi_timed')
        throw new Error('Swimming timed format is unavailable.');
      const personIds = Array.from({ length: ATHLETES }, () => newId());

      await withOrg(owner, async (trx) => {
        await trx
          .insertInto('org_memberships')
          .values({
            id: newId(),
            org_id: orgId,
            account_id: accountId,
            status: 'active',
            joined_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('role_assignments')
          .values({
            id: newId(),
            org_id: orgId,
            account_id: accountId,
            role: 'owner',
            scope_type: 'org',
            pending_mfa: false,
          })
          .execute();
        await trx
          .insertInto('seasons')
          .values({
            id: seasonId,
            org_id: orgId,
            name: 'Meet Season',
            starts_on: '2026-01-01',
            ends_on: '2026-12-31',
          })
          .execute();
        await trx
          .insertInto('sport_profiles')
          .values({
            id: sportProfileId,
            org_id: orgId,
            name: 'Swimming',
            profile: swimmer,
          })
          .execute();
        const profileVersion = await trx
          .selectFrom('sport_profile_versions')
          .select('version')
          .where('org_id', '=', orgId)
          .where('sport_profile_id', '=', sportProfileId)
          .where('version', '=', 1)
          .executeTakeFirst();
        if (!profileVersion)
          await trx
            .insertInto('sport_profile_versions')
            .values({
              org_id: orgId,
              sport_profile_id: sportProfileId,
              version: 1,
              profile: swimmer,
              created_by: accountId,
            })
            .execute();
        await trx
          .insertInto('programs')
          .values({
            id: programId,
            org_id: orgId,
            season_id: seasonId,
            sport_profile_id: sportProfileId,
            mode: 'league',
            name: 'Meet Program',
            slug: `meet-${randomUUID().slice(0, 12)}`,
            starts_on: '2026-03-01',
            ends_on: '2026-11-30',
          })
          .execute();
        await trx
          .insertInto('divisions')
          .values({
            id: divisionId,
            org_id: orgId,
            program_id: programId,
            name: 'Open',
            level: 'open',
          })
          .execute();
        for (const [index, teamSeasonId] of teamSeasonIds.entries()) {
          const teamId = newId();
          await trx
            .insertInto('teams')
            .values({
              id: teamId,
              org_id: orgId,
              name: `Club ${String(index + 1)}`,
              sport_profile_id: sportProfileId,
            })
            .execute();
          await trx
            .insertInto('team_seasons')
            .values({
              id: teamSeasonId,
              org_id: orgId,
              team_id: teamId,
              program_id: programId,
              division_id: divisionId,
            })
            .execute();
        }
        await trx
          .insertInto('people')
          .values(
            personIds.map((personId, index) => ({
              id: personId,
              org_id: orgId,
              first_name: `Swimmer${String(index + 1)}`,
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
              org_id: orgId,
              team_season_id: teamSeasonIds[index % 2] ?? '',
              person_id: personId,
            })),
          )
          .execute();
      });

      const eventIds = MEET_EVENTS.map(() => newId());
      await withOrg(owner, async (trx) => {
        for (const [eventIndex, eventId] of eventIds.entries()) {
          await trx
            .insertInto('events')
            .values({
              id: eventId,
              org_id: orgId,
              program_id: programId,
              division_id: divisionId,
              kind: 'meet',
              title: `Meet event ${String(MEET_EVENTS[eventIndex] ?? eventIndex)}`,
              starts_at: new Date(
                `2026-09-19T${String(14 + eventIndex).padStart(2, '0')}:00:00Z`,
              ),
              ends_at: new Date(
                `2026-09-19T${String(15 + eventIndex).padStart(2, '0')}:00:00Z`,
              ),
              timezone: 'America/Chicago',
            })
            .execute();
          await trx
            .insertInto('event_participants')
            .values(
              personIds.map((personId) => ({
                id: newId(),
                org_id: orgId,
                event_id: eventId,
                person_id: personId,
              })),
            )
            .execute();
        }
      });

      const teamTotals = new Map<string, number>();
      for (const [eventIndex, eventId] of eventIds.entries()) {
        const contest = await createContest(owner, eventId, {
          formatIndex: 0,
          stage: 'regular',
          countsForStandings: false,
        });
        const roster = await withOrg(owner, (trx) =>
          trx
            .selectFrom('contest_participants')
            .select(['id', 'person_id', 'team_season_id'])
            .where('org_id', '=', orgId)
            .where('contest_id', '=', contest.id)
            .execute(),
        );
        expect(roster).toHaveLength(ATHLETES);
        const byPerson = new Map(
          roster.map((row) => [row.person_id, row] as const),
        );
        const seedOrder = personIds.map((personId, index) => ({
          personId,
          seed: index + 1,
        }));
        const seeded = await assignMeetParticipants(owner, contest.id, {
          expectedVersion: contest.version,
          assignments: seedOrder.map(({ personId, seed }) => {
            const participant = byPerson.get(personId);
            if (!participant) throw new Error('Participant missing.');
            return {
              participantId: participant.id,
              seed,
              heat: 6 - Math.ceil(seed / LANES),
              lane: ((seed - 1) % LANES) + 1,
            };
          }),
        });
        expect(seeded.version).toBe(contest.version + 1);

        const values = personIds.map(
          (_, index) => 30_000 + index * 250 + eventIndex * 10,
        );
        if (eventIndex === 0) {
          values[2] = values[1] ?? 30_250;
        }
        const places = expectedPlaces(values);
        const entries = personIds.map((personId, index) => {
          const participant = byPerson.get(personId);
          if (!participant) throw new Error('Participant missing.');
          return { participantId: participant.id, value: values[index] ?? 0 };
        });
        const submitted = await submitContestResult(owner, contest.id, {
          expectedVersion: seeded.version,
          result: { entries },
          finalize: true,
        });
        expect(submitted.status).toBe('final');

        const detail = await listContestResults(owner, eventId);
        if (!detail) throw new Error('Contest detail missing.');
        expect(detail.results).toHaveLength(ATHLETES);
        for (const row of detail.results) {
          const participant = roster.find(
            (item) => item.id === row.participant_id,
          );
          const personIndex = personIds.indexOf(participant?.person_id ?? '');
          expect(row.place).toBe(places[personIndex] ?? null);
          const expectedPoints =
            row.place === null ? 0 : (PLACE_POINTS[row.place - 1] ?? 0);
          expect(Number(row.points_awarded)).toBe(expectedPoints);
        }
        for (const team of detail.teamScores)
          teamTotals.set(
            team.teamSeasonId,
            (teamTotals.get(team.teamSeasonId) ?? 0) + team.points,
          );
      }

      const [teamA, teamB] = teamSeasonIds;
      if (!teamA || !teamB) throw new Error('Team fixtures missing.');
      expect(teamTotals.get(teamA)).toBe(61);
      expect(teamTotals.get(teamB)).toBe(36);

      const firstEventDetail = await listContestResults(
        owner,
        eventIds[0] ?? '',
      );
      if (!firstEventDetail) throw new Error('First meet results missing.');
      const tied = firstEventDetail.results
        .filter((row) => {
          const participant = rosterFor(firstEventDetail, row.participant_id);
          return [1, 2].includes(
            personIds.indexOf(participant?.person_id ?? ''),
          );
        })
        .map((row) => row.place);
      expect(tied).toEqual([2, 2]);
      expect(
        firstEventDetail.results.filter((row) => row.place === 3),
      ).toHaveLength(0);
    },
  );
});

function rosterFor(
  detail: { participants: readonly { id: string; person_id: string | null }[] },
  participantId: string,
) {
  return detail.participants.find((item) => item.id === participantId);
}
