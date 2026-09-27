import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { listPersonPersonalBests } from './service';

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
      ],
    };
    const events = [newId(), newId()];
    const contests = [newId(), newId()];
    const dates = ['2026-09-01T12:00:00Z', '2026-09-08T12:00:00Z'];
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
            format: 'multi_timed',
            status: 'final',
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

    await expect(
      listPersonPersonalBests(
        { orgId, actor: { accountId: strangerId } },
        personId,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
