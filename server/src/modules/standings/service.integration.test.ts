import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { StandingsConfig } from '@shared/sport/schema';
import type { StandingRow } from '@shared/sport/standings';
import {
  builtInSportTemplates,
  builtInSportTemplatesByKey,
} from '@shared/sport/templates';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { createContest, submitContestResult } from '../contests/service';

import { listSeasonAwards } from './season-end';
import {
  configureStandings,
  getStandings,
  recomputeDirtyStandings,
  recomputeStandingsForEvent,
  refreshStandings,
} from './service';

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

    await expect(listSeasonAwards(actor, programId)).resolves.toEqual([]);

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

  it('recomputes after finalization, correction and forfeit results', async () => {
    const accountId = newId();
    const orgId = newId();
    const seasonId = newId();
    const profileId = newId();
    const programId = newId();
    const divisionId = newId();
    const teamSeasonA = newId();
    const teamSeasonB = newId();
    const actor: OrgContext = { orgId, actor: { accountId } };
    const soccer = builtInSportTemplatesByKey.get('soccer');
    if (!soccer) throw new Error('Soccer template is unavailable.');

    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `recompute-${accountId}@example.invalid`,
        first_name: 'Recompute',
        last_name: 'Manager',
        date_of_birth: '1990-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `recompute-${randomUUID().slice(0, 12)}`,
        name: 'Recompute Test',
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
          name: 'Recompute Season',
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
            profile: soccer,
            created_by: accountId,
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
          name: 'Recompute League',
          slug: `recompute-${randomUUID().slice(0, 12)}`,
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
      for (const [index, teamSeasonId] of [
        teamSeasonA,
        teamSeasonB,
      ].entries()) {
        const teamId = newId();
        await trx
          .insertInto('teams')
          .values({
            id: teamId,
            org_id: orgId,
            name: `Club ${String(index + 1)}`,
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
    });

    const config = {
      basis: 'match',
      points: {
        win: 3,
        overtimeWin: 3,
        tie: 1,
        overtimeLoss: 0,
        loss: 0,
        forfeitWin: 3,
        forfeitLoss: 0,
        forfeitDeduction: 1,
      },
      rankBy: 'points',
      winPercentageTieValue: 0.5,
      forfeitScore: { winner: 3, loser: 0 },
      tiebreakers: ['wins', 'differential'],
      include: { stages: ['regular', 'playoff'], crossDivision: false },
      columns: [
        'rank',
        'team',
        'played',
        'wins',
        'losses',
        'ties',
        'forfeits',
        'points',
      ],
      publicVisibility: 'public',
    } satisfies StandingsConfig;
    await configureStandings(actor, { divisionId }, config);

    const gameAt = async (hour: number) => {
      const eventId = newId();
      await createWithOrg(database)(actor, async (trx) => {
        await trx
          .insertInto('events')
          .values({
            id: eventId,
            org_id: orgId,
            program_id: programId,
            division_id: divisionId,
            kind: 'game',
            title: `League game ${String(hour)}`,
            starts_at: new Date(`2026-10-03T${String(hour)}:00:00Z`),
            ends_at: new Date(`2026-10-03T${String(hour + 1)}:00:00Z`),
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
              team_season_id: teamSeasonA,
              side: 'home',
            },
            {
              id: newId(),
              org_id: orgId,
              event_id: eventId,
              team_season_id: teamSeasonB,
              side: 'away',
            },
          ])
          .execute();
      });
      return createContest(actor, eventId, {
        formatIndex: 0,
        stage: 'regular',
        countsForStandings: true,
      });
    };
    const rowFor = async (teamSeasonId: string) => {
      const snapshot = await createWithOrg(database)(actor, (trx) =>
        trx
          .selectFrom('standings_snapshots')
          .select('rows')
          .where('org_id', '=', orgId)
          .where('scope_type', '=', 'division')
          .where('scope_id', '=', divisionId)
          .orderBy('computed_at', 'desc')
          .executeTakeFirst(),
      );
      const rows = (snapshot?.rows ?? []) as unknown as StandingRow[];
      const row = rows.find((item) => item.teamId === teamSeasonId);
      if (!row) throw new Error('Standings row missing.');
      return row;
    };

    const gameOne = await gameAt(14);
    const firstSubmit = await submitContestResult(actor, gameOne.id, {
      expectedVersion: gameOne.version,
      result: { home: 3, away: 1 },
      finalize: true,
    });
    expect(firstSubmit.status).toBe('final');
    expect(await rowFor(teamSeasonA)).toMatchObject({
      played: 1,
      wins: 1,
      losses: 0,
      ties: 0,
      points: 3,
      rank: 1,
    });
    expect(await rowFor(teamSeasonB)).toMatchObject({
      played: 1,
      wins: 0,
      losses: 1,
      points: 0,
      rank: 2,
    });

    const corrected = await submitContestResult(actor, gameOne.id, {
      expectedVersion: firstSubmit.version,
      result: { home: 2, away: 2 },
      finalize: true,
      correctionReason: 'Scorekeeper entered the wrong totals.',
    });
    expect(corrected.status).toBe('final');
    for (const teamSeasonId of [teamSeasonA, teamSeasonB])
      expect(await rowFor(teamSeasonId)).toMatchObject({
        played: 1,
        wins: 0,
        losses: 0,
        ties: 1,
        points: 1,
      });

    await expect(
      submitContestResult(actor, gameOne.id, {
        expectedVersion: gameOne.version,
        result: { home: 4, away: 0 },
        finalize: true,
        correctionReason: 'Stale offline score sync.',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });

    const gameTwo = await gameAt(16);
    const forfeited = await submitContestResult(actor, gameTwo.id, {
      expectedVersion: gameTwo.version,
      result: {
        home: 3,
        away: 0,
        forfeitBy: 'away',
        forfeitScore: { winner: 3, loser: 0 },
      },
      finalize: true,
    });
    expect(forfeited.status).toBe('forfeit');
    expect(await rowFor(teamSeasonA)).toMatchObject({
      played: 2,
      wins: 1,
      ties: 1,
      losses: 0,
      forfeits: 0,
      points: 4,
      rank: 1,
    });
    expect(await rowFor(teamSeasonB)).toMatchObject({
      played: 2,
      wins: 0,
      ties: 1,
      losses: 1,
      forfeits: 1,
      points: 0,
      rank: 2,
    });

    // A result finalized while another transaction recomputes the same scope
    // is deferred, then the dirty-scope sweep catches up exactly once.
    const withOrgHere = createWithOrg(database);
    let releaseHolder: () => void = () => undefined;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holderLocked = resolve;
    });
    const holder = withOrgHere(actor, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`standings:${orgId}:program:${programId}`}, 0))`.execute(
        trx,
      );
      holderLocked();
      await holderReleased;
    });
    await locked;
    await withOrgHere(actor, (trx) =>
      recomputeStandingsForEvent(trx, actor, programId, null),
    );
    releaseHolder();
    await holder;
    const dirty = () =>
      withOrgHere(actor, (trx) =>
        trx
          .selectFrom('standings_dirty_scopes')
          .select(['scope_type', 'scope_id'])
          .where('org_id', '=', orgId)
          .execute(),
      );
    expect(await dirty()).toEqual([
      { scope_type: 'program', scope_id: programId },
    ]);
    const snapshotsBefore = await withOrgHere(actor, (trx) =>
      trx
        .selectFrom('standings_snapshots')
        .select('id')
        .where('org_id', '=', orgId)
        .where('scope_id', '=', programId)
        .execute(),
    );
    expect(await recomputeDirtyStandings(database, orgId)).toBe(1);
    expect(await dirty()).toEqual([]);
    const snapshotsAfter = await withOrgHere(actor, (trx) =>
      trx
        .selectFrom('standings_snapshots')
        .select('id')
        .where('org_id', '=', orgId)
        .where('scope_id', '=', programId)
        .execute(),
    );
    expect(snapshotsAfter).toHaveLength(snapshotsBefore.length + 1);
    expect(await recomputeDirtyStandings(database, orgId)).toBe(0);
  });
});
