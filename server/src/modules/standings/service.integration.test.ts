import { newId } from '@shared/ids';
import type { StandingsConfig } from '@shared/sport/schema';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { configureStandings, getStandings, refreshStandings } from './service';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for standings tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});

afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

describe('standings snapshots', () => {
  it('returns team display names and enforces public visibility', async () => {
    const accountId = newId();
    const orgId = newId();
    const seasonId = newId();
    const profileId = newId();
    const programId = newId();
    const divisionId = newId();
    const teamId = newId();
    const teamSeasonId = newId();
    const actor: OrgContext = { orgId, actor: { accountId } };
    const profile = builtInSportTemplates[0];

    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `standings-${accountId}@example.invalid`,
        first_name: 'Standings',
        last_name: 'Manager',
        date_of_birth: '1990-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `standings-${orgId.slice(0, 8)}`,
        name: 'Standings Test',
        kind: 'club',
        timezone: 'UTC',
      })
      .execute();
    await createWithOrg(database)(actor, async (trx) => {
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
          name: 'Standings Season',
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
          profile,
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
          name: 'Standings League',
          slug: `standings-${programId.slice(0, 8)}`,
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
      await trx
        .insertInto('teams')
        .values({
          id: teamId,
          org_id: orgId,
          name: 'Comets',
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
          display_name: 'Northside Comets',
        })
        .execute();
    });

    const refreshed = await refreshStandings(actor, {
      programId,
    });
    expect(refreshed.teamNames[teamSeasonId]).toBe('Northside Comets');
    expect(refreshed.rows[0]?.teamId).toBe(teamSeasonId);

    const defaultConfig = profile.defaultStandings;
    if (!defaultConfig)
      throw new Error('The sport template has no standings defaults.');
    const config = {
      ...defaultConfig,
      publicVisibility: 'public',
    } satisfies StandingsConfig;
    await configureStandings(actor, { programId }, config);

    const publicContext: OrgContext = {
      orgId,
      actor: { accountId: newId() },
    };
    const publicData = await getStandings(publicContext, { programId }, true);
    expect(publicData.teamNames[teamSeasonId]).toBe('Northside Comets');

    await configureStandings(
      actor,
      {
        programId,
      },
      {
        ...config,
        publicVisibility: 'hidden',
      },
      1,
    );
    await expect(
      getStandings(publicContext, { programId }, true),
    ).rejects.toMatchObject({ status: 404 });
  });
});
