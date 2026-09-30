import { newId } from '@shared/ids';
import { standingsConfigSchema } from '@shared/sport/schema';
import type { StandingsConfig } from '@shared/sport/schema';
import { computeStandings } from '@shared/sport/standings';
import type { StandingRow, StandingContest } from '@shared/sport/standings';

import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { assertSchedulePermission } from '../scheduling/access';
import { SchedulingRuleError } from '../scheduling/events';

export type ConfigScope = { programId?: string; divisionId?: string };

function configFor(
  rows: readonly { config: unknown }[],
  fallback: unknown,
): StandingsConfig | null {
  const raw = rows[0]?.config ?? fallback;
  if (!raw) return null;
  return standingsConfigSchema.parse(raw);
}

const UNCONFIGURED_MESSAGE =
  'Standings rules have not been configured for this program.';

async function scopeConfig(
  trx: OrgTransaction,
  orgId: string,
  scope: ConfigScope,
) {
  if (scope.divisionId) {
    const division = await trx
      .selectFrom('divisions')
      .select(['id', 'program_id'])
      .where('org_id', '=', orgId)
      .where('id', '=', scope.divisionId)
      .executeTakeFirst();
    if (!division)
      throw new SchedulingRuleError('Division not found.', 404, 'NOT_FOUND');
    const configured = await trx
      .selectFrom('standings_configs')
      .select(['config', 'version'])
      .where('org_id', '=', orgId)
      .where('division_id', '=', division.id)
      .execute();
    const programConfig = await trx
      .selectFrom('standings_configs')
      .select(['config', 'version'])
      .where('org_id', '=', orgId)
      .where('program_id', '=', division.program_id)
      .execute();
    const program = await trx
      .selectFrom('programs')
      .innerJoin('sport_profiles', (join) =>
        join
          .onRef('sport_profiles.org_id', '=', 'programs.org_id')
          .onRef('sport_profiles.id', '=', 'programs.sport_profile_id'),
      )
      .select([
        'programs.id',
        'programs.name',
        'programs.season_id',
        'sport_profiles.profile',
      ])
      .where('programs.org_id', '=', orgId)
      .where('programs.id', '=', division.program_id)
      .executeTakeFirstOrThrow();
    const profile = program.profile as { defaultStandings?: unknown };
    const config = configFor(
      configured,
      programConfig[0]?.config ?? profile.defaultStandings,
    );
    return {
      config,
      configVersion: configured[0]?.version ?? null,
      programId: division.program_id,
      divisionId: division.id,
    };
  }
  if (!scope.programId)
    throw new SchedulingRuleError('A program or division scope is required.');
  const program = await trx
    .selectFrom('programs')
    .innerJoin('sport_profiles', (join) =>
      join
        .onRef('sport_profiles.org_id', '=', 'programs.org_id')
        .onRef('sport_profiles.id', '=', 'programs.sport_profile_id'),
    )
    .select([
      'programs.id',
      'programs.name',
      'programs.season_id',
      'sport_profiles.profile',
    ])
    .where('programs.org_id', '=', orgId)
    .where('programs.id', '=', scope.programId)
    .executeTakeFirst();
  if (!program)
    throw new SchedulingRuleError('Program not found.', 404, 'NOT_FOUND');
  const configured = await trx
    .selectFrom('standings_configs')
    .select(['config', 'version'])
    .where('org_id', '=', orgId)
    .where('program_id', '=', program.id)
    .execute();
  const profile = program.profile as { defaultStandings?: unknown };
  const config = configFor(configured, profile.defaultStandings);
  return {
    config,
    configVersion: configured[0]?.version ?? null,
    programId: program.id,
    divisionId: null,
  };
}

function numericScore(score: number | string | null): number | null {
  if (score === null) return null;
  const value = typeof score === 'number' ? score : Number(score);
  return Number.isFinite(value) ? value : null;
}

function rowsForTeamStandings(
  contests: readonly {
    stage: string;
    counts_for_standings: boolean;
    status: string;
    event_division_id: string | null;
    home_team: string | null;
    away_team: string | null;
    home_score: number | null;
    away_score: number | null;
    home_detail: unknown;
    away_detail: unknown;
  }[],
): StandingContest[] {
  return contests.flatMap((row) => {
    const homeScore = numericScore(row.home_score);
    const awayScore = numericScore(row.away_score);
    if (
      !row.home_team ||
      !row.away_team ||
      homeScore === null ||
      awayScore === null
    )
      return [];
    const homeDetail = (row.home_detail ?? {}) as Record<string, unknown>;
    const awayDetail = (row.away_detail ?? {}) as Record<string, unknown>;
    const sets = Array.isArray(homeDetail.sets)
      ? (homeDetail.sets as Array<{ home?: number; away?: number }>)
      : [];
    const forfeitBy =
      homeDetail.forfeitBy === 'home' || homeDetail.forfeitBy === 'away'
        ? homeDetail.forfeitBy
        : undefined;
    const overtimeWinner =
      homeDetail.shootoutWinner === 'home' ||
      homeDetail.shootoutWinner === 'away'
        ? homeDetail.shootoutWinner
        : undefined;
    const homeDisciplinePoints =
      typeof homeDetail.disciplinePoints === 'number'
        ? homeDetail.disciplinePoints
        : 0;
    const awayDisciplinePoints =
      typeof awayDetail.disciplinePoints === 'number'
        ? awayDetail.disciplinePoints
        : 0;
    const homeTries =
      typeof homeDetail.tries === 'number' ? homeDetail.tries : undefined;
    const awayTries =
      typeof awayDetail.tries === 'number' ? awayDetail.tries : undefined;
    const contest: StandingContest = {
      homeTeamId: row.home_team,
      awayTeamId: row.away_team,
      ...(row.event_division_id
        ? {
            homeDivisionId: row.event_division_id,
            awayDivisionId: row.event_division_id,
          }
        : {}),
      stage: row.stage as StandingContest['stage'],
      finalized: ['final', 'forfeit'].includes(row.status),
      countsForStandings: row.counts_for_standings,
      homeScore,
      awayScore,
      ...(forfeitBy ? { forfeitBy } : {}),
      ...(overtimeWinner ? { overtimeWinner } : {}),
      ...(sets.length
        ? {
            homeSets: sets.filter((set) => (set.home ?? 0) > (set.away ?? 0))
              .length,
            awaySets: sets.filter((set) => (set.away ?? 0) > (set.home ?? 0))
              .length,
            homeSetPoints: sets.reduce((n, set) => n + (set.home ?? 0), 0),
            awaySetPoints: sets.reduce((n, set) => n + (set.away ?? 0), 0),
          }
        : {}),
      ...(homeDisciplinePoints || awayDisciplinePoints
        ? { homeDisciplinePoints, awayDisciplinePoints }
        : {}),
      ...(homeTries !== undefined ? { homeTries } : {}),
      ...(awayTries !== undefined ? { awayTries } : {}),
      ...(typeof homeDetail.ballsFaced === 'number'
        ? { homeBallsFaced: homeDetail.ballsFaced }
        : {}),
      ...(typeof awayDetail.ballsFaced === 'number'
        ? { awayBallsFaced: awayDetail.ballsFaced }
        : {}),
    };
    return [contest];
  });
}

type SnapshotComputation = {
  config: StandingsConfig;
  configVersion: number | null;
  programId: string;
  divisionId: string | null;
  rows: StandingRow[];
  teamNames: Record<string, string>;
};

async function computeSnapshot(
  trx: OrgTransaction,
  orgId: string,
  scope: ConfigScope,
  manualOrder?: readonly string[],
): Promise<SnapshotComputation>;
async function computeSnapshot(
  trx: OrgTransaction,
  orgId: string,
  scope: ConfigScope,
  manualOrder: undefined,
  optional: true,
): Promise<SnapshotComputation | null>;
async function computeSnapshot(
  trx: OrgTransaction,
  orgId: string,
  scope: ConfigScope,
  manualOrder?: readonly string[],
  optional = false,
): Promise<SnapshotComputation | null> {
  const resolved = await scopeConfig(trx, orgId, scope);
  if (!resolved.config) {
    if (optional) return null;
    throw new SchedulingRuleError(UNCONFIGURED_MESSAGE, 409, 'CONFLICT');
  }
  const config = resolved.config;
  const teamsQuery = trx
    .selectFrom('team_seasons')
    .select(['id', 'division_id'])
    .where('org_id', '=', orgId)
    .where('program_id', '=', resolved.programId)
    .where('status', '!=', 'archived');
  const teams = resolved.divisionId
    ? await teamsQuery
        .where('division_id', '=', resolved.divisionId)
        .orderBy('display_name')
        .execute()
    : await teamsQuery.orderBy('display_name').execute();
  const teamIds = teams.map((team) => team.id);
  const contestsQuery = trx
    .selectFrom('contests')
    .innerJoin('events', (join) =>
      join
        .onRef('events.org_id', '=', 'contests.org_id')
        .onRef('events.id', '=', 'contests.event_id'),
    )
    .leftJoin('contest_participants as home_cp', (join) =>
      join
        .onRef('home_cp.org_id', '=', 'contests.org_id')
        .onRef('home_cp.contest_id', '=', 'contests.id')
        .on('home_cp.side', '=', 'home'),
    )
    .leftJoin('contest_participants as away_cp', (join) =>
      join
        .onRef('away_cp.org_id', '=', 'contests.org_id')
        .onRef('away_cp.contest_id', '=', 'contests.id')
        .on('away_cp.side', '=', 'away'),
    )
    .leftJoin('contest_results as home_result', (join) =>
      join
        .onRef('home_result.org_id', '=', 'home_cp.org_id')
        .onRef('home_result.contest_participant_id', '=', 'home_cp.id'),
    )
    .leftJoin('contest_results as away_result', (join) =>
      join
        .onRef('away_result.org_id', '=', 'away_cp.org_id')
        .onRef('away_result.contest_participant_id', '=', 'away_cp.id'),
    )
    .select([
      'contests.stage',
      'contests.counts_for_standings',
      'contests.status',
      'events.division_id as event_division_id',
      'home_cp.team_season_id as home_team',
      'away_cp.team_season_id as away_team',
      'home_result.score as home_score',
      'away_result.score as away_score',
      'home_result.score_detail as home_detail',
      'away_result.score_detail as away_detail',
    ])
    .where('contests.org_id', '=', orgId)
    .where('events.program_id', '=', resolved.programId)
    .where('contests.status', 'in', ['final', 'forfeit']);
  const contestRows = resolved.divisionId
    ? await contestsQuery
        .where('events.division_id', '=', resolved.divisionId)
        .execute()
    : await contestsQuery.execute();
  const rows = computeStandings(
    teamIds,
    rowsForTeamStandings(contestRows),
    config,
    {
      ...(resolved.divisionId ? { divisionId: resolved.divisionId } : {}),
      ...(manualOrder ? { manualOrder } : {}),
    },
  );
  return {
    ...resolved,
    config,
    rows,
    teamNames: await teamNamesForRows(
      trx,
      orgId,
      rows.map((row) => row.teamId),
    ),
  };
}

async function teamNamesForRows(
  trx: OrgTransaction,
  orgId: string,
  teamIds: readonly string[],
): Promise<Record<string, string>> {
  if (!teamIds.length) return {};
  const teams = await trx
    .selectFrom('team_seasons')
    .innerJoin('teams', (join) =>
      join
        .onRef('teams.org_id', '=', 'team_seasons.org_id')
        .onRef('teams.id', '=', 'team_seasons.team_id'),
    )
    .select(['team_seasons.id', 'team_seasons.display_name', 'teams.name'])
    .where('team_seasons.org_id', '=', orgId)
    .where('team_seasons.id', 'in', [...teamIds])
    .execute();
  return Object.fromEntries(
    teams.map((team) => [team.id, team.display_name?.trim() || team.name]),
  );
}

async function persistSnapshot(
  trx: OrgTransaction,
  orgId: string,
  scopeType: 'program' | 'division',
  scopeId: string,
  rows: readonly StandingRow[],
) {
  const id = newId();
  await trx
    .insertInto('standings_snapshots')
    .values({
      id,
      org_id: orgId,
      scope_type: scopeType,
      scope_id: scopeId,
      rows: JSON.stringify(rows) as unknown as import('../../db/types').Json,
    })
    .execute();
  return id;
}

export async function recomputeStandingsForEvent(
  trx: OrgTransaction,
  context: OrgContext,
  programId: string | null,
  divisionId: string | null,
): Promise<void> {
  if (divisionId) {
    const result = await computeSnapshot(
      trx,
      context.orgId,
      { divisionId },
      undefined,
      true,
    );
    if (result)
      await persistSnapshot(
        trx,
        context.orgId,
        'division',
        divisionId,
        result.rows,
      );
  }
  if (programId) {
    const result = await computeSnapshot(
      trx,
      context.orgId,
      { programId },
      undefined,
      true,
    );
    if (result)
      await persistSnapshot(
        trx,
        context.orgId,
        'program',
        programId,
        result.rows,
      );
  }
}

export async function configureStandings(
  context: OrgContext,
  scope: ConfigScope,
  config: unknown,
  expectedVersion?: number,
) {
  const parsed = standingsConfigSchema.parse(config);
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', scope);
    let resolved: { programId: string; divisionId: string | null };
    if (scope.divisionId) {
      const division = await trx
        .selectFrom('divisions')
        .select(['id', 'program_id'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', scope.divisionId)
        .executeTakeFirst();
      if (!division)
        throw new SchedulingRuleError('Division not found.', 404, 'NOT_FOUND');
      resolved = { programId: division.program_id, divisionId: division.id };
    } else if (scope.programId) {
      const program = await trx
        .selectFrom('programs')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', scope.programId)
        .executeTakeFirst();
      if (!program)
        throw new SchedulingRuleError('Program not found.', 404, 'NOT_FOUND');
      resolved = { programId: program.id, divisionId: null };
    } else
      throw new SchedulingRuleError('A program or division scope is required.');
    const column = resolved.divisionId ? 'division_id' : 'program_id';
    const idValue = resolved.divisionId ?? resolved.programId;
    const existing = await trx
      .selectFrom('standings_configs')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where(column, '=', idValue)
      .executeTakeFirst();
    if (existing) {
      if (expectedVersion !== existing.version)
        throw new Error(
          'Standings configuration changed; reload before saving.',
        );
      return trx
        .updateTable('standings_configs')
        .set({
          config: parsed as unknown as import('../../db/types').Json,
          version: existing.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', existing.id)
        .where('version', '=', existing.version)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return trx
      .insertInto('standings_configs')
      .values({
        id: newId(),
        org_id: context.orgId,
        program_id: resolved.divisionId ? null : resolved.programId,
        division_id: resolved.divisionId,
        config: parsed as unknown as import('../../db/types').Json,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function refreshStandings(
  context: OrgContext,
  scope: ConfigScope,
  manualOrder?: readonly string[],
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', scope);
    const result = await computeSnapshot(
      trx,
      context.orgId,
      scope,
      manualOrder,
    );
    const scopeId = result.divisionId ?? result.programId;
    const scopeType = result.divisionId ? 'division' : 'program';
    const snapshotId = await persistSnapshot(
      trx,
      context.orgId,
      scopeType,
      scopeId,
      result.rows,
    );
    return {
      id: snapshotId,
      scopeType,
      scopeId,
      computedAt: new Date().toISOString(),
      rows: result.rows,
      teamNames: result.teamNames,
      config: result.config,
      configVersion: result.configVersion,
    };
  });
}

export async function getStandings(
  context: OrgContext,
  scope: ConfigScope,
  publicRequest = false,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const resolved = await scopeConfig(trx, context.orgId, scope);
    if (!resolved.config)
      throw new SchedulingRuleError(UNCONFIGURED_MESSAGE, 409, 'CONFLICT');
    if (publicRequest && resolved.config.publicVisibility !== 'public')
      throw new SchedulingRuleError(
        'Standings are not public.',
        404,
        'NOT_FOUND',
      );
    if (!publicRequest)
      await assertSchedulePermission(trx, context, 'results.read', {
        ...(resolved.programId ? { programId: resolved.programId } : {}),
        ...(resolved.divisionId ? { divisionId: resolved.divisionId } : {}),
      });
    const scopeId = resolved.divisionId ?? resolved.programId;
    const scopeType = resolved.divisionId ? 'division' : 'program';
    const snapshot = await trx
      .selectFrom('standings_snapshots')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('scope_type', '=', scopeType)
      .where('scope_id', '=', scopeId)
      .orderBy('computed_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (snapshot)
      return {
        ...snapshot,
        config: resolved.config,
        configVersion: resolved.configVersion,
        teamNames: await teamNamesForRows(
          trx,
          context.orgId,
          ((snapshot.rows ?? []) as unknown as StandingRow[]).map(
            (row) => row.teamId,
          ),
        ),
      };
    const computed = await computeSnapshot(trx, context.orgId, scope);
    return {
      rows: computed.rows,
      computed_at: null,
      scope_type: scopeType,
      scope_id: scopeId,
      config: resolved.config,
      configVersion: resolved.configVersion,
      teamNames: computed.teamNames,
    };
  });
}

export async function getPublicStandingsBySlug(
  orgSlug: string,
  scope: ConfigScope,
) {
  const { getDatabase } = await import('../../db/kysely');
  const database = getDatabase();
  const organization = await database
    .selectFrom('organizations')
    .select('id')
    .where('slug', '=', orgSlug)
    .executeTakeFirst();
  if (!organization)
    throw new SchedulingRuleError('Standings not found.', 404, 'NOT_FOUND');
  return getStandings(
    { orgId: organization.id, actor: { accountId: newId() } },
    scope,
    true,
  );
}
