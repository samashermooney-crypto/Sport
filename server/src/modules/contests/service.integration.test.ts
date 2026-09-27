import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import {
  contestDetail,
  listPersonPersonalBests,
  listProgramStatLeaders,
  getProgramStatSettings,
  listTeamStats,
  updateProgramStatSettings,
} from './service';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for contest tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});

afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

describe('contest statistics', () => {
  it('returns scoped athlete personal bests using public sport definitions', async () => {
    const accountId = newId();
    const strangerId = newId();
    const orgId = newId();
    const personId = newId();
    const profileId = newId();
    const seasonId = newId();
    const programId = newId();
    const divisionId = newId();
    const teamIds = [newId(), newId()];
    const teamSeasonIds = [newId(), newId()];
    const actor: OrgContext = { orgId, actor: { accountId } };
    const baseProfile = builtInSportTemplates[0];
    const profile = {
      ...baseProfile,
      stats: [
        {
          key: 'sprint_100',
          label: { en: '100 m', es: '100 m' },
          abbreviation: '100m',
          level: 'athlete',
          valueType: 'time_ms',
          aggregate: 'min',
          public: true,
        },
        {
          key: 'points',
          label: { en: 'Points', es: 'Puntos' },
          abbreviation: 'PTS',
          level: 'athlete',
          valueType: 'integer',
          aggregate: 'max',
          public: true,
        },
        {
          key: 'private_mark',
          label: { en: 'Private mark', es: 'Marca privada' },
          abbreviation: 'PM',
          level: 'athlete',
          valueType: 'decimal',
          aggregate: 'max',
          public: false,
        },
        {
          key: 'goals',
          label: { en: 'Goals', es: 'Goles' },
          abbreviation: 'G',
          level: 'team',
          valueType: 'integer',
          aggregate: 'sum',
          public: true,
        },
      ],
    };
    const events = [newId(), newId(), newId()];
    const contests = [newId(), newId(), newId()];
    const dates = [
      '2026-09-01T12:00:00Z',
      '2026-09-08T12:00:00Z',
      '2026-09-15T12:00:00Z',
    ];
    const withOrg = createWithOrg(database);

    for (const id of [accountId, strangerId])
      await database
        .insertInto('accounts')
        .values({
          id,
          email: `contest-${id}@example.invalid`,
          first_name: 'Contest',
          last_name: 'Viewer',
          date_of_birth: '1990-01-01',
          email_verified_at: new Date(),
        })
        .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `contest-${orgId.slice(0, 8)}`,
        name: 'Contest Test',
        kind: 'club',
        timezone: 'UTC',
      })
      .execute();

    await withOrg(actor, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values([
          {
            id: newId(),
            org_id: orgId,
            account_id: accountId,
            status: 'active',
            joined_at: new Date(),
          },
          {
            id: newId(),
            org_id: orgId,
            account_id: strangerId,
            status: 'active',
            joined_at: new Date(),
          },
        ])
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
        .insertInto('people')
        .values({
          id: personId,
          org_id: orgId,
          first_name: 'Fast',
          last_name: 'Runner',
          date_of_birth: '2012-06-01',
        })
        .execute();
      await trx
        .insertInto('sport_profiles')
        .values({
          id: profileId,
          org_id: orgId,
          name: 'Track',
          profile,
        })
        .execute();
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: 'Track 2026',
          starts_on: '2026-09-01',
          ends_on: '2026-12-31',
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
          name: 'Track 2026',
          slug: `track-${orgId.slice(0, 8)}`,
          starts_on: '2026-09-01',
          ends_on: '2026-12-31',
          settings: {
            statsEnabled: ['sprint_100', 'points', 'private_mark', 'goals'],
          },
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
      await trx
        .insertInto('teams')
        .values(
          teamIds.map((id, index) => ({
            id,
            org_id: orgId,
            name: `Track Team ${String(index + 1)}`,
            sport_profile_id: profileId,
          })),
        )
        .execute();
      await trx
        .insertInto('team_seasons')
        .values(
          teamSeasonIds.map((id, index) => ({
            id,
            org_id: orgId,
            team_id: teamIds[index] ?? '',
            program_id: programId,
            division_id: divisionId,
          })),
        )
        .execute();
      const profileVersion = await trx
        .selectFrom('sport_profile_versions')
        .select('version')
        .where('org_id', '=', orgId)
        .where('sport_profile_id', '=', profileId)
        .where('version', '=', 1)
        .executeTakeFirst();
      if (!profileVersion)
        await trx
          .insertInto('sport_profile_versions')
          .values({
            org_id: orgId,
            sport_profile_id: profileId,
            version: 1,
            profile,
            created_by: accountId,
          })
          .execute();
      for (let index = 0; index < events.length; index += 1) {
        const eventId = events[index];
        const contestId = contests[index];
        const startsAt = dates[index];
        if (!eventId || !contestId || !startsAt) continue;
        await trx
          .insertInto('events')
          .values({
            id: eventId,
            org_id: orgId,
            title: `Meet ${String(index + 1)}`,
            kind: 'meet',
            program_id: programId,
            division_id: divisionId,
            starts_at: startsAt,
            ends_at: new Date(new Date(startsAt).getTime() + 3_600_000),
            timezone: 'UTC',
          })
          .execute();
        await trx
          .insertInto('contests')
          .values({
            id: contestId,
            org_id: orgId,
            event_id: eventId,
            sport_profile_id: profileId,
            profile_version: 1,
            format: profile.contestFormats[0]?.format ?? 'head_to_head_score',
            status: index === 2 ? 'in_progress' : 'final',
          })
          .execute();
        await trx
          .insertInto('stat_lines')
          .values([
            {
              id: newId(),
              org_id: orgId,
              contest_id: contestId,
              person_id: personId,
              team_season_id: null,
              stat_key: 'sprint_100',
              value: index === 0 ? 20_000 : 18_000,
            },
            {
              id: newId(),
              org_id: orgId,
              contest_id: contestId,
              person_id: personId,
              team_season_id: null,
              stat_key: 'points',
              value: index === 0 ? 10 : 12,
            },
            {
              id: newId(),
              org_id: orgId,
              contest_id: contestId,
              person_id: personId,
              team_season_id: null,
              stat_key: 'private_mark',
              value: 99,
            },
            {
              id: newId(),
              org_id: orgId,
              contest_id: contestId,
              person_id: null,
              team_season_id: teamSeasonIds[0] ?? null,
              stat_key: 'goals',
              value: index === 0 ? 2 : index === 1 ? 4 : 100,
            },
            {
              id: newId(),
              org_id: orgId,
              contest_id: contestId,
              person_id: null,
              team_season_id: teamSeasonIds[1] ?? null,
              stat_key: 'goals',
              value: index === 0 ? 1 : index === 1 ? 3 : 99,
            },
          ])
          .execute();
      }
    });

    const result = await listPersonPersonalBests(actor, personId);
    expect(result.items.map((item) => [item.key, item.value])).toEqual([
      ['points', 12],
      ['sprint_100', 18_000],
    ]);
    expect(
      result.items.find((item) => item.key === 'sprint_100')?.achievedAt,
    ).toBe('2026-09-08T12:00:00.000Z');

    const leaderboards = await listProgramStatLeaders(actor, { programId });
    expect(
      leaderboards.items.find((item) => item.key === 'sprint_100')?.leaders,
    ).toMatchObject([{ subjectLabel: 'Fast Runner', value: 18_000, rank: 1 }]);
    expect(
      leaderboards.items.find((item) => item.key === 'private_mark'),
    ).toBeUndefined();
    expect(
      leaderboards.items.find((item) => item.key === 'goals')?.leaders,
    ).toMatchObject([
      { subjectLabel: 'Track Team 1', value: 6, rank: 1 },
      { subjectLabel: 'Track Team 2', value: 4, rank: 2 },
    ]);
    const teamStats = await listTeamStats(actor, {
      teamSeasonId: teamSeasonIds[0] ?? '',
    });
    expect(teamStats.summary.goals).toBe(6);
    const statSettings = await getProgramStatSettings(actor, programId);
    expect(statSettings.enabledStatKeys).toEqual([
      'goals',
      'points',
      'private_mark',
      'sprint_100',
    ]);
    const savedSettings = await updateProgramStatSettings(actor, programId, {
      expectedVersion: statSettings.version,
      enabledStatKeys: ['points', 'private_mark'],
    });
    expect(savedSettings.enabledStatKeys).toEqual(['points', 'private_mark']);
    await expect(
      updateProgramStatSettings(actor, programId, {
        expectedVersion: statSettings.version,
        enabledStatKeys: ['points'],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      updateProgramStatSettings(actor, programId, {
        expectedVersion: savedSettings.version,
        enabledStatKeys: ['not-a-profile-stat'],
      }),
    ).rejects.toMatchObject({ status: 400 });

    const firstContestId = contests[0];
    if (!firstContestId) throw new Error('Expected a seeded contest.');
    const contest = await contestDetail(actor, firstContestId);
    expect(contest.statDefinitions.map((definition) => definition.key)).toEqual(
      ['points', 'private_mark'],
    );
    expect(
      (await listProgramStatLeaders(actor, { programId })).items.map(
        (item) => item.key,
      ),
    ).toEqual(['points']);
    const disabledTeamStats = await listTeamStats(actor, {
      teamSeasonId: teamSeasonIds[0] ?? '',
    });
    expect(disabledTeamStats.definitions).toEqual([]);
    expect(
      (await listPersonPersonalBests(actor, personId)).items,
    ).toMatchObject([{ key: 'points', value: 12 }]);

    await expect(
      listPersonPersonalBests(
        { orgId, actor: { accountId: strangerId } },
        personId,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      getProgramStatSettings(
        { orgId, actor: { accountId: strangerId } },
        programId,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
