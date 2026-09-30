import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplatesByKey } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { createContest, submitContestResult } from './service';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for discipline tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});

afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

describe('contest result discipline', () => {
  it('records cards from finalized results and serves suspensions on later team games once', async () => {
    const orgId = newId();
    const accountId = newId();
    const actor: OrgContext = { orgId, actor: { accountId } };
    const seasonId = newId();
    const profileId = newId();
    const programId = newId();
    const divisionId = newId();
    const teamSeasonIds = [newId(), newId()];
    const carded = newId();
    const cautioned = newId();
    const outsider = newId();
    const eventIds = [newId(), newId(), newId()];
    const soccer = builtInSportTemplatesByKey.get('soccer');
    if (!soccer) throw new Error('Soccer template unavailable');
    const withOrg = createWithOrg(database);

    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `discipline-${accountId}@example.invalid`,
        first_name: 'Result',
        last_name: 'Entry',
        date_of_birth: '1990-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `discipline-${randomUUID().slice(0, 12)}`,
        name: 'Discipline Test Org',
        kind: 'league',
        timezone: 'UTC',
      })
      .execute();
    await withOrg(actor, async (trx) => {
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
          name: 'Discipline Season',
          starts_on: '2026-01-01',
          ends_on: '2026-12-31',
        })
        .execute();
      await trx
        .insertInto('sport_profiles')
        .values({
          id: profileId,
          org_id: orgId,
          name: 'Soccer',
          profile: soccer,
        })
        .execute();
      await trx
        .insertInto('programs')
        .values({
          id: programId,
          org_id: orgId,
          season_id: seasonId,
          sport_profile_id: profileId,
          mode: 'league',
          name: 'Discipline league',
          slug: `discipline-${randomUUID().slice(0, 8)}`,
          starts_on: '2026-01-01',
          ends_on: '2026-12-31',
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
            name: `Discipline team ${String(index + 1)}`,
            sport_profile_id: profileId,
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
          [carded, cautioned, outsider].map((id, index) => ({
            id,
            org_id: orgId,
            first_name: `Player${String(index + 1)}`,
            last_name: 'Discipline',
            date_of_birth: '2011-01-01',
          })),
        )
        .execute();
      await trx
        .insertInto('roster_entries')
        .values([
          {
            id: newId(),
            org_id: orgId,
            team_season_id: teamSeasonIds[0] ?? '',
            person_id: carded,
          },
          {
            id: newId(),
            org_id: orgId,
            team_season_id: teamSeasonIds[1] ?? '',
            person_id: cautioned,
          },
        ])
        .execute();
      for (const [index, eventId] of eventIds.entries()) {
        await trx
          .insertInto('events')
          .values({
            id: eventId,
            org_id: orgId,
            program_id: programId,
            division_id: divisionId,
            kind: 'game',
            title: `Discipline game ${String(index + 1)}`,
            starts_at: new Date(Date.UTC(2026, 9, 3 + index * 7, 14)),
            ends_at: new Date(Date.UTC(2026, 9, 3 + index * 7, 15)),
            timezone: 'UTC',
          })
          .execute();
        await trx
          .insertInto('event_participants')
          .values([
            {
              id: newId(),
              org_id: orgId,
              event_id: eventId,
              team_season_id: teamSeasonIds[0] ?? '',
              side: 'home',
            },
            {
              id: newId(),
              org_id: orgId,
              event_id: eventId,
              team_season_id: teamSeasonIds[1] ?? '',
              side: 'away',
            },
          ])
          .execute();
      }
    });
    const contests = [];
    for (const eventId of eventIds)
      contests.push(
        await createContest(actor, eventId, {
          formatIndex: 0,
          stage: 'regular',
          countsForStandings: true,
        }),
      );
    const [first, second, third] = contests;
    if (!first || !second || !third) throw new Error('Contests missing');
    const records = () =>
      withOrg(actor, (trx) =>
        trx
          .selectFrom('discipline_records')
          .select([
            'person_id',
            'team_season_id',
            'contest_id',
            'type',
            'suspension_games',
            'games_served',
            'status',
          ])
          .where('org_id', '=', orgId)
          .orderBy('type')
          .execute(),
      );

    await expect(
      submitContestResult(actor, first.id, {
        expectedVersion: first.version,
        finalize: true,
        result: {
          home: 1,
          away: 0,
          cards: [{ personId: outsider, type: 'red_card' }],
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'NOT_ON_TEAM' });
    expect(await records()).toEqual([]);

    const firstFinal = await submitContestResult(actor, first.id, {
      expectedVersion: first.version,
      finalize: true,
      result: {
        home: 1,
        away: 0,
        cards: [
          { personId: carded, type: 'red_card' },
          { personId: cautioned, type: 'yellow_card' },
        ],
      },
    });
    expect(firstFinal.status).toBe('final');
    expect(await records()).toEqual([
      {
        person_id: cautioned,
        team_season_id: teamSeasonIds[1],
        contest_id: first.id,
        type: 'caution',
        suspension_games: null,
        games_served: 0,
        status: 'active',
      },
      {
        person_id: carded,
        team_season_id: teamSeasonIds[0],
        contest_id: first.id,
        type: 'send_off',
        suspension_games: 1,
        games_served: 0,
        status: 'active',
      },
    ]);

    // Correcting the carded game must neither duplicate the card nor count
    // the game in which it was issued as served.
    await submitContestResult(actor, first.id, {
      expectedVersion: firstFinal.version,
      finalize: true,
      correctionReason: 'Score correction',
      result: {
        home: 2,
        away: 0,
        cards: [
          { personId: carded, type: 'red_card' },
          { personId: cautioned, type: 'yellow_card' },
        ],
      },
    });
    expect(await records()).toHaveLength(2);
    expect((await records())[1]).toMatchObject({
      games_served: 0,
      status: 'active',
    });

    const secondFinal = await submitContestResult(actor, second.id, {
      expectedVersion: second.version,
      finalize: true,
      result: { home: 0, away: 0 },
    });
    expect((await records())[1]).toMatchObject({
      games_served: 1,
      status: 'served',
    });
    await submitContestResult(actor, second.id, {
      expectedVersion: secondFinal.version,
      finalize: true,
      correctionReason: 'Late score correction',
      result: { home: 1, away: 0 },
    });
    await submitContestResult(actor, third.id, {
      expectedVersion: third.version,
      finalize: true,
      result: { home: 3, away: 1 },
    });
    expect((await records())[1]).toMatchObject({
      games_served: 1,
      status: 'served',
    });
    const served = await withOrg(actor, (trx) =>
      trx
        .selectFrom('discipline_games_served')
        .select('contest_id')
        .where('org_id', '=', orgId)
        .execute(),
    );
    expect(served).toEqual([{ contest_id: second.id }]);
  });
});
