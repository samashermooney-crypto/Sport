import {
  crossSeedPools,
  finalizeBracketMatch,
  generateDoubleElimination,
  generateSingleElimination,
} from '@shared/algorithms/brackets';
import type {
  Bracket,
  BracketEntrant,
  BracketMatch,
  BracketSlot,
} from '@shared/algorithms/brackets';
import { circlePairings } from '@shared/algorithms/schedule-generator';
import type { Pairing } from '@shared/algorithms/schedule-generator';
import { newId } from '@shared/ids';
import { standingsConfigSchema } from '@shared/sport/schema';
import { computeStandings } from '@shared/sport/standings';
import type { StandingContest } from '@shared/sport/standings';

import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { VersionConflictError } from '../../lib/version-check';
import { assertSchedulePermission } from '../scheduling/access';
import { SchedulingRuleError } from '../scheduling/events';

type SlotJson = {
  entrantId?: string | null;
  sourceMatchId?: string | null;
  sourceOutcome?: 'winner' | 'loser' | null;
  winnerId?: string | null;
  finalized?: boolean;
  bracketKind?: 'winners' | 'losers' | 'final';
  poolId?: string | null;
  poolName?: string | null;
};

type PoolMemberInput = {
  id: string;
  teamSeasonId: string | null;
  externalTeamId: string | null;
};

function numericScore(score: number | string): number {
  return typeof score === 'number' ? score : Number(score);
}

export function roundRobinPoolPairings(
  pools: readonly { id: string; members: readonly PoolMemberInput[] }[],
): Array<Pairing & { poolId: string; position: number }> {
  const result: Array<Pairing & { poolId: string; position: number }> = [];
  const positions = new Map<number, number>();
  for (const pool of pools) {
    const teamIds = pool.members.map(
      (member) => member.teamSeasonId ?? member.externalTeamId ?? member.id,
    );
    const pairings = circlePairings({
      id: pool.id,
      teamIds,
      allowedWeekdays: [],
      timeWindows: [],
    });
    for (const pairing of pairings) {
      const position = (positions.get(pairing.round) ?? 0) + 1;
      positions.set(pairing.round, position);
      result.push({ ...pairing, poolId: pool.id, position });
    }
  }
  return result;
}

function slotFrom(value: unknown, ids: Map<string, string>): BracketSlot {
  const slot = (value ?? {}) as SlotJson;
  return {
    entrantId: slot.entrantId ?? null,
    sourceMatchId: slot.sourceMatchId
      ? (ids.get(slot.sourceMatchId) ?? slot.sourceMatchId)
      : null,
    sourceOutcome: slot.sourceOutcome ?? null,
  };
}

function persistedRound(match: BracketMatch, rounds: number): number {
  if (match.bracket === 'losers') return rounds + match.round;
  if (match.bracket === 'final') return rounds * 3 + match.round;
  return match.round;
}

async function poolStandingsForBracket(
  trx: OrgTransaction,
  orgId: string,
  bracketId: string,
  programId: string,
  divisionId: string | null,
) {
  const pools = await trx
    .selectFrom('pools')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('bracket_id', '=', bracketId)
    .orderBy('sort_order')
    .execute();
  if (!pools.length) return [];
  const members = await trx
    .selectFrom('pool_members')
    .selectAll()
    .where('org_id', '=', orgId)
    .where(
      'pool_id',
      'in',
      pools.map((pool) => pool.id),
    )
    .orderBy('seed')
    .execute();
  const profile = await trx
    .selectFrom('programs')
    .innerJoin('sport_profiles', (join) =>
      join
        .onRef('sport_profiles.org_id', '=', 'programs.org_id')
        .onRef('sport_profiles.id', '=', 'programs.sport_profile_id'),
    )
    .select('sport_profiles.profile')
    .where('programs.org_id', '=', orgId)
    .where('programs.id', '=', programId)
    .executeTakeFirstOrThrow();
  const configRows = await trx
    .selectFrom('standings_configs')
    .select('config')
    .where('org_id', '=', orgId)
    .where('program_id', '=', programId)
    .execute();
  const profileData = profile.profile as { defaultStandings?: unknown };
  const config = standingsConfigSchema.parse(
    configRows[0]?.config ?? profileData.defaultStandings,
  );
  const poolMatchRows = await trx
    .selectFrom('bracket_matches')
    .leftJoin('contests', (join) =>
      join
        .onRef('contests.org_id', '=', 'bracket_matches.org_id')
        .onRef('contests.id', '=', 'bracket_matches.contest_id'),
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
      'bracket_matches.participant_a',
      'contests.status as contest_status',
      'contests.stage as contest_stage',
      'contests.counts_for_standings',
      'home_cp.team_season_id as home_team',
      'home_cp.external_team_id as home_external_team',
      'away_cp.team_season_id as away_team',
      'away_cp.external_team_id as away_external_team',
      'home_result.score as home_score',
      'away_result.score as away_score',
      'home_result.score_detail as home_detail',
    ])
    .where('bracket_matches.org_id', '=', orgId)
    .where('bracket_matches.bracket_id', '=', bracketId)
    .execute();
  return pools.map((pool) => {
    const poolMembers = members.filter((member) => member.pool_id === pool.id);
    const teamIds = poolMembers.flatMap((member) =>
      member.team_season_id
        ? [member.team_season_id]
        : member.external_team_id
          ? [member.external_team_id]
          : [],
    );
    const contests: StandingContest[] = poolMatchRows.flatMap((row) => {
      const slot = (row.participant_a ?? {}) as { poolId?: string };
      const homeTeam = row.home_team ?? row.home_external_team;
      const awayTeam = row.away_team ?? row.away_external_team;
      if (
        slot.poolId !== pool.id ||
        !homeTeam ||
        !awayTeam ||
        row.home_score === null ||
        row.away_score === null ||
        !row.contest_status ||
        !row.contest_stage
      )
        return [];
      const detail = (row.home_detail ?? {}) as Record<string, unknown>;
      const sets = Array.isArray(detail.sets)
        ? (detail.sets as Array<{ home?: number; away?: number }>)
        : [];
      return [
        {
          homeTeamId: homeTeam,
          awayTeamId: awayTeam,
          ...(divisionId
            ? { homeDivisionId: divisionId, awayDivisionId: divisionId }
            : {}),
          stage: row.contest_stage as StandingContest['stage'],
          finalized: ['final', 'forfeit'].includes(row.contest_status),
          countsForStandings: row.counts_for_standings ?? false,
          homeScore: numericScore(row.home_score),
          awayScore: numericScore(row.away_score),
          ...(detail.forfeitBy === 'home' || detail.forfeitBy === 'away'
            ? { forfeitBy: detail.forfeitBy }
            : {}),
          ...(sets.length
            ? {
                homeSets: sets.filter(
                  (set) => (set.home ?? 0) > (set.away ?? 0),
                ).length,
                awaySets: sets.filter(
                  (set) => (set.away ?? 0) > (set.home ?? 0),
                ).length,
                homeSetPoints: sets.reduce(
                  (sum, set) => sum + (set.home ?? 0),
                  0,
                ),
                awaySetPoints: sets.reduce(
                  (sum, set) => sum + (set.away ?? 0),
                  0,
                ),
              }
            : {}),
        },
      ];
    });
    const poolConfig = config.include.stages.includes('pool')
      ? config
      : {
          ...config,
          include: {
            ...config.include,
            stages: [...config.include.stages, 'pool' as const],
          },
        };
    return {
      ...pool,
      members: poolMembers,
      standings: computeStandings(teamIds, contests, poolConfig, {
        ...(divisionId ? { divisionId } : {}),
      }),
    };
  });
}

function appendThirdPlaceMatch(generated: Bracket, enabled: boolean): void {
  if (!enabled || generated.kind !== 'single' || generated.size < 4) return;
  const semifinalRound = Math.log2(generated.size) - 1;
  const semifinals = generated.matches.filter(
    (match) => match.round === semifinalRound,
  );
  if (semifinals.length !== 2) return;
  const thirdPlaceId = 'THIRD-1';
  generated.matches.push({
    id: thirdPlaceId,
    bracket: 'final',
    round: Math.log2(generated.size) + 1,
    position: 1,
    home: {
      entrantId: null,
      sourceMatchId: semifinals[0]?.id ?? null,
      sourceOutcome: 'loser',
    },
    away: {
      entrantId: null,
      sourceMatchId: semifinals[1]?.id ?? null,
      sourceOutcome: 'loser',
    },
    winnerId: null,
    finalized: false,
    winnerTo: null,
    loserTo: null,
  });
  const first = semifinals[0];
  const second = semifinals[1];
  if (first) first.loserTo = { matchId: thirdPlaceId, slot: 'home' };
  if (second) second.loserTo = { matchId: thirdPlaceId, slot: 'away' };
}

async function persistBracketMatches(
  trx: OrgTransaction,
  orgId: string,
  bracketId: string,
  generated: Bracket,
  roundOffset = 0,
): Promise<void> {
  const matchIdByLabel = new Map(
    generated.matches.map((match) => [match.id, newId()]),
  );
  const rounds = Math.log2(generated.size);
  for (const match of generated.matches) {
    const a = {
      ...match.home,
      sourceMatchId: match.home.sourceMatchId
        ? (matchIdByLabel.get(match.home.sourceMatchId) ?? null)
        : null,
      bracketKind: match.bracket,
      winnerId: match.winnerId,
      finalized: match.finalized,
    };
    const b = {
      ...match.away,
      sourceMatchId: match.away.sourceMatchId
        ? (matchIdByLabel.get(match.away.sourceMatchId) ?? null)
        : null,
      bracketKind: match.bracket,
      winnerId: match.winnerId,
      finalized: match.finalized,
    };
    await trx
      .insertInto('bracket_matches')
      .values({
        id: matchIdByLabel.get(match.id) as string,
        org_id: orgId,
        bracket_id: bracketId,
        round: persistedRound(match, rounds) + roundOffset,
        position: match.position,
        participant_a: a as unknown as import('../../db/types').Json,
        participant_b: b as unknown as import('../../db/types').Json,
      })
      .execute();
  }
  for (const match of generated.matches) {
    await trx
      .updateTable('bracket_matches')
      .set({
        winner_to_match_id: match.winnerTo
          ? (matchIdByLabel.get(match.winnerTo.matchId) ?? null)
          : null,
        winner_to_slot:
          match.winnerTo?.slot === 'home'
            ? 'a'
            : match.winnerTo?.slot === 'away'
              ? 'b'
              : null,
        loser_to_match_id: match.loserTo
          ? (matchIdByLabel.get(match.loserTo.matchId) ?? null)
          : null,
        loser_to_slot:
          match.loserTo?.slot === 'home'
            ? 'a'
            : match.loserTo?.slot === 'away'
              ? 'b'
              : null,
      })
      .where('org_id', '=', orgId)
      .where('id', '=', matchIdByLabel.get(match.id) as string)
      .execute();
  }
}

async function bindEliminationReservations(
  trx: OrgTransaction,
  orgId: string,
  bracketId: string,
): Promise<void> {
  const matchRows = await trx
    .selectFrom('bracket_matches')
    .select(['id', 'round', 'position', 'participant_a', 'participant_b'])
    .where('org_id', '=', orgId)
    .where('bracket_id', '=', bracketId)
    .orderBy('round')
    .orderBy('position')
    .execute();
  const poolOffset = matchRows.reduce((maximum, row) => {
    const slot = (row.participant_a ?? {}) as SlotJson;
    return slot.poolId ? Math.max(maximum, row.round) : maximum;
  }, 0);
  const reservations = await trx
    .selectFrom('tournament_schedule_reservations')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('bracket_id', '=', bracketId)
    .where('slot_type', '=', 'bracket')
    .where('bracket_match_id', 'is', null)
    .orderBy('round_index')
    .orderBy('position')
    .execute();
  for (const reservation of reservations) {
    const candidates = matchRows.filter((row) => {
      const home = (row.participant_a ?? {}) as SlotJson;
      const away = (row.participant_b ?? {}) as SlotJson;
      return (
        row.round === poolOffset + reservation.round_index &&
        !home.finalized &&
        !away.finalized
      );
    });
    const match = candidates[reservation.position - 1];
    if (!match) continue;
    await trx
      .updateTable('tournament_schedule_reservations')
      .set({
        bracket_match_id: match.id,
        version: reservation.version + 1,
      })
      .where('org_id', '=', orgId)
      .where('id', '=', reservation.id)
      .where('bracket_match_id', 'is', null)
      .execute();
  }
}

export async function createBracket(
  context: OrgContext,
  input: {
    programId: string;
    divisionId?: string;
    name: string;
    type:
      | 'single_elim'
      | 'double_elim'
      | 'round_robin_pools'
      | 'pools_to_bracket'
      | 'consolation'
      | 'ladder';
    seedingSource: 'manual' | 'standings' | 'pool_results' | 'random';
    thirdPlace?: boolean;
    config?: Record<string, unknown>;
    entries: Array<{
      teamSeasonId?: string;
      externalTeamId?: string;
      seed?: number;
    }>;
  },
) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'tournaments.manage', {
      programId: input.programId,
      ...(input.divisionId ? { divisionId: input.divisionId } : {}),
    });
    if (!input.entries.length || input.entries.length > 1024)
      throw new SchedulingRuleError(
        'A tournament requires between 1 and 1024 entries.',
      );
    if (
      input.entries.some(
        (entry) =>
          Boolean(entry.teamSeasonId) === Boolean(entry.externalTeamId),
      )
    )
      throw new SchedulingRuleError(
        'Each tournament entry must name exactly one team.',
      );
    const bracketId = newId();
    const bracketSize = input.entries.length;
    await trx
      .insertInto('brackets')
      .values({
        id: bracketId,
        org_id: context.orgId,
        program_id: input.programId,
        division_id: input.divisionId ?? null,
        name: input.name,
        type: input.type,
        size: bracketSize,
        seeding_source: input.seedingSource,
        third_place: input.thirdPlace ?? false,
        config: (input.config ?? {}) as import('../../db/types').Json,
      })
      .execute();
    const createdEntries: string[] = [];
    const ordered = [...input.entries].sort(
      (a, b) =>
        (a.seed ?? Number.MAX_SAFE_INTEGER) -
        (b.seed ?? Number.MAX_SAFE_INTEGER),
    );
    for (const [index, entry] of ordered.entries()) {
      const id = newId();
      createdEntries.push(id);
      await trx
        .insertInto('tournament_entries')
        .values({
          id,
          org_id: context.orgId,
          bracket_id: bracketId,
          team_season_id: entry.teamSeasonId ?? null,
          external_team_id: entry.externalTeamId ?? null,
          seed: entry.seed ?? index + 1,
        })
        .execute();
    }
    return {
      id: bracketId,
      entryIds: createdEntries,
      status: 'draft',
      version: 1,
    };
  });
}

export async function getBracket(context: OrgContext, bracketId: string) {
  return withOrg(context, async (trx) => {
    const bracket = await trx
      .selectFrom('brackets')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', bracketId)
      .executeTakeFirst();
    if (!bracket)
      throw new SchedulingRuleError('Tournament not found.', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'results.read', {
      programId: bracket.program_id,
      ...(bracket.division_id ? { divisionId: bracket.division_id } : {}),
    });
    const entries = await trx
      .selectFrom('tournament_entries')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('bracket_id', '=', bracketId)
      .orderBy('seed')
      .execute();
    const matches = await trx
      .selectFrom('bracket_matches')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('bracket_id', '=', bracketId)
      .orderBy('round')
      .orderBy('position')
      .execute();
    const pools = await trx
      .selectFrom('pools')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('bracket_id', '=', bracketId)
      .orderBy('sort_order')
      .execute();
    const reservations = await trx
      .selectFrom('tournament_schedule_reservations as reservation')
      .innerJoin('events as event', (join) =>
        join
          .onRef('event.org_id', '=', 'reservation.org_id')
          .onRef('event.id', '=', 'reservation.event_id'),
      )
      .select([
        'reservation.id',
        'reservation.slot_type',
        'reservation.round_index',
        'reservation.position',
        'reservation.bracket_match_id',
        'reservation.home_placeholder',
        'reservation.away_placeholder',
        'event.id as event_id',
        'event.title',
        'event.starts_at',
        'event.ends_at',
        'event.timezone',
        'event.space_id',
        'event.status',
        'event.published',
      ])
      .where('reservation.org_id', '=', context.orgId)
      .where('reservation.bracket_id', '=', bracketId)
      .orderBy('reservation.slot_type')
      .orderBy('reservation.round_index')
      .orderBy('reservation.position')
      .execute();
    if (!pools.length)
      return { bracket, entries, matches, pools: [], reservations };
    const poolMembers = await trx
      .selectFrom('pool_members')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where(
        'pool_id',
        'in',
        pools.map((pool) => pool.id),
      )
      .orderBy('seed')
      .execute();
    const profile = await trx
      .selectFrom('programs')
      .innerJoin('sport_profiles', (join) =>
        join
          .onRef('sport_profiles.org_id', '=', 'programs.org_id')
          .onRef('sport_profiles.id', '=', 'programs.sport_profile_id'),
      )
      .select('sport_profiles.profile')
      .where('programs.org_id', '=', context.orgId)
      .where('programs.id', '=', bracket.program_id)
      .executeTakeFirstOrThrow();
    const configRows = await trx
      .selectFrom('standings_configs')
      .select('config')
      .where('org_id', '=', context.orgId)
      .where('program_id', '=', bracket.program_id)
      .execute();
    const profileData = profile.profile as { defaultStandings?: unknown };
    const config = standingsConfigSchema.parse(
      configRows[0]?.config ?? profileData.defaultStandings,
    );
    const poolMatchRows = await trx
      .selectFrom('bracket_matches')
      .leftJoin('contests', (join) =>
        join
          .onRef('contests.org_id', '=', 'bracket_matches.org_id')
          .onRef('contests.id', '=', 'bracket_matches.contest_id'),
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
        'bracket_matches.participant_a',
        'contests.status as contest_status',
        'contests.stage as contest_stage',
        'contests.counts_for_standings',
        'home_cp.team_season_id as home_team',
        'home_cp.external_team_id as home_external_team',
        'away_cp.team_season_id as away_team',
        'away_cp.external_team_id as away_external_team',
        'home_result.score as home_score',
        'away_result.score as away_score',
        'home_result.score_detail as home_detail',
        'away_result.score_detail as away_detail',
      ])
      .where('bracket_matches.org_id', '=', context.orgId)
      .where('bracket_matches.bracket_id', '=', bracketId)
      .execute();
    const poolSummaries = pools.map((pool) => {
      const members = poolMembers.filter(
        (member) => member.pool_id === pool.id,
      );
      const teamIds = members.flatMap((member) =>
        member.team_season_id
          ? [member.team_season_id]
          : member.external_team_id
            ? [member.external_team_id]
            : [],
      );
      const contests: StandingContest[] = poolMatchRows.flatMap((row) => {
        const slot = (row.participant_a ?? {}) as { poolId?: string };
        const homeTeam = row.home_team ?? row.home_external_team;
        const awayTeam = row.away_team ?? row.away_external_team;
        if (
          slot.poolId !== pool.id ||
          !homeTeam ||
          !awayTeam ||
          row.home_score === null ||
          row.away_score === null ||
          !row.contest_status ||
          !row.contest_stage
        )
          return [];
        const homeDetail = (row.home_detail ?? {}) as Record<string, unknown>;
        const sets = Array.isArray(homeDetail.sets)
          ? (homeDetail.sets as Array<{ home?: number; away?: number }>)
          : [];
        return [
          {
            homeTeamId: homeTeam,
            awayTeamId: awayTeam,
            ...(bracket.division_id
              ? {
                  homeDivisionId: bracket.division_id,
                  awayDivisionId: bracket.division_id,
                }
              : {}),
            stage: row.contest_stage as StandingContest['stage'],
            finalized: ['final', 'forfeit'].includes(row.contest_status),
            countsForStandings: row.counts_for_standings ?? false,
            homeScore: numericScore(row.home_score),
            awayScore: numericScore(row.away_score),
            ...(homeDetail.forfeitBy === 'home' ||
            homeDetail.forfeitBy === 'away'
              ? { forfeitBy: homeDetail.forfeitBy }
              : {}),
            ...(sets.length
              ? {
                  homeSets: sets.filter(
                    (set) => (set.home ?? 0) > (set.away ?? 0),
                  ).length,
                  awaySets: sets.filter(
                    (set) => (set.away ?? 0) > (set.home ?? 0),
                  ).length,
                  homeSetPoints: sets.reduce(
                    (sum, set) => sum + (set.home ?? 0),
                    0,
                  ),
                  awaySetPoints: sets.reduce(
                    (sum, set) => sum + (set.away ?? 0),
                    0,
                  ),
                }
              : {}),
          },
        ];
      });
      const poolConfig = config.include.stages.includes('pool')
        ? config
        : {
            ...config,
            include: {
              ...config.include,
              stages: [...config.include.stages, 'pool' as const],
            },
          };
      return {
        ...pool,
        members,
        standings: computeStandings(teamIds, contests, poolConfig, {
          ...(bracket.division_id ? { divisionId: bracket.division_id } : {}),
        }),
      };
    });
    return { bracket, entries, matches, pools: poolSummaries, reservations };
  });
}

export async function getPublicBracketBySlug(
  orgSlug: string,
  bracketId: string,
) {
  const { getDatabase } = await import('../../db/kysely');
  const database = getDatabase();
  const organization = await database
    .selectFrom('organizations')
    .select('id')
    .where('slug', '=', orgSlug)
    .executeTakeFirst();
  if (!organization)
    throw new SchedulingRuleError('Tournament not found.', 404, 'NOT_FOUND');
  const context: OrgContext = {
    orgId: organization.id,
    actor: { accountId: newId() },
  };
  return withOrg(context, async (trx) => {
    const bracket = await trx
      .selectFrom('brackets')
      .select(['id', 'name', 'type', 'size', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', bracketId)
      .where('status', '!=', 'draft')
      .executeTakeFirst();
    if (!bracket)
      throw new SchedulingRuleError('Tournament not found.', 404, 'NOT_FOUND');
    const entries = await trx
      .selectFrom('tournament_entries')
      .leftJoin('team_seasons', (join) =>
        join
          .onRef('team_seasons.org_id', '=', 'tournament_entries.org_id')
          .onRef('team_seasons.id', '=', 'tournament_entries.team_season_id'),
      )
      .leftJoin('teams', (join) =>
        join
          .onRef('teams.org_id', '=', 'team_seasons.org_id')
          .onRef('teams.id', '=', 'team_seasons.team_id'),
      )
      .leftJoin('external_teams', (join) =>
        join
          .onRef('external_teams.org_id', '=', 'tournament_entries.org_id')
          .onRef(
            'external_teams.id',
            '=',
            'tournament_entries.external_team_id',
          ),
      )
      .select([
        'tournament_entries.seed',
        'tournament_entries.team_season_id',
        'tournament_entries.external_team_id',
        'team_seasons.display_name as team_display_name',
        'teams.name as team_name',
        'external_teams.name as external_team_name',
      ])
      .where('tournament_entries.org_id', '=', context.orgId)
      .where('tournament_entries.bracket_id', '=', bracketId)
      .where('tournament_entries.status', '!=', 'withdrawn')
      .orderBy('tournament_entries.seed')
      .execute();
    const matches = await trx
      .selectFrom('bracket_matches')
      .select([
        'id',
        'round',
        'position',
        'contest_id',
        'participant_a',
        'participant_b',
      ])
      .where('org_id', '=', context.orgId)
      .where('bracket_id', '=', bracketId)
      .orderBy('round')
      .orderBy('position')
      .execute();
    const reservations = await trx
      .selectFrom('tournament_schedule_reservations as reservation')
      .innerJoin('events as event', (join) =>
        join
          .onRef('event.org_id', '=', 'reservation.org_id')
          .onRef('event.id', '=', 'reservation.event_id'),
      )
      .select([
        'reservation.slot_type',
        'reservation.round_index',
        'reservation.position',
        'event.title',
        'event.starts_at',
        'event.timezone',
      ])
      .where('reservation.org_id', '=', context.orgId)
      .where('reservation.bracket_id', '=', bracketId)
      .where('event.published', '=', true)
      .where('event.status', '=', 'scheduled')
      .orderBy('reservation.slot_type')
      .orderBy('reservation.round_index')
      .orderBy('reservation.position')
      .execute();
    return { bracket, entries, matches, reservations };
  });
}

export async function listBrackets(context: OrgContext, programId: string) {
  return withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'results.read', { programId });
    return trx
      .selectFrom('brackets')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('program_id', '=', programId)
      .orderBy('created_at', 'desc')
      .execute();
  });
}

export async function checkInTournamentTeam(
  context: OrgContext,
  bracketId: string,
  entryId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    const bracket = await trx
      .selectFrom('brackets')
      .select(['program_id', 'division_id'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', bracketId)
      .executeTakeFirst();
    if (!bracket)
      throw new SchedulingRuleError('Tournament not found.', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'tournaments.manage', {
      programId: bracket.program_id,
      ...(bracket.division_id ? { divisionId: bracket.division_id } : {}),
    });
    const entry = await trx
      .selectFrom('tournament_entries')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', entryId)
      .where('bracket_id', '=', bracketId)
      .executeTakeFirst();
    if (!entry)
      throw new SchedulingRuleError(
        'Tournament entry not found.',
        404,
        'NOT_FOUND',
      );
    if (entry.version !== expectedVersion)
      throw new VersionConflictError(entry);
    if (entry.status === 'withdrawn')
      throw new SchedulingRuleError(
        'Withdrawn entries cannot check in.',
        409,
        'CONFLICT',
      );
    return trx
      .updateTable('tournament_entries')
      .set({
        status: 'checked_in',
        checked_in_at: new Date(),
        checked_in_by: context.actor.accountId,
        version: entry.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', entry.id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

async function seedEntrants(
  trx: OrgTransaction,
  orgId: string,
  bracketId: string,
) {
  const entries = await trx
    .selectFrom('tournament_entries')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('bracket_id', '=', bracketId)
    .where('status', 'in', ['entered', 'checked_in'])
    .orderBy('seed')
    .execute();
  return {
    entrants: entries.map((entry, index) => ({
      id: entry.team_season_id ?? entry.external_team_id ?? entry.id,
      seed: entry.seed ?? index + 1,
    })),
  };
}

export async function generateBracket(
  context: OrgContext,
  bracketId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    const bracket = await trx
      .selectFrom('brackets')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', bracketId)
      .executeTakeFirst();
    if (!bracket)
      throw new SchedulingRuleError('Tournament not found.', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'tournaments.manage', {
      programId: bracket.program_id,
      ...(bracket.division_id ? { divisionId: bracket.division_id } : {}),
    });
    if (bracket.version !== expectedVersion)
      throw new VersionConflictError(bracket);
    if (bracket.status !== 'draft')
      throw new SchedulingRuleError(
        'Only a draft tournament can be generated.',
        409,
        'CONFLICT',
      );
    const { entrants } = await seedEntrants(trx, context.orgId, bracketId);
    if (entrants.length < 2)
      throw new SchedulingRuleError(
        'A bracket needs at least two entries.',
        409,
        'CONFLICT',
      );
    if (bracket.type === 'double_elim' && entrants.length < 3)
      throw new SchedulingRuleError(
        'Double elimination needs at least three entries.',
        409,
        'CONFLICT',
      );
    const entryRows = await trx
      .selectFrom('tournament_entries')
      .select(['seed'])
      .where('org_id', '=', context.orgId)
      .where('bracket_id', '=', bracketId)
      .where('status', 'in', ['entered', 'checked_in'])
      .execute();
    const configuredSeeds = entryRows
      .filter((entry) => entry.seed !== null)
      .map((entry) => entry.seed as number)
      .sort((a, b) => a - b);
    if (
      configuredSeeds.length !== entrants.length ||
      configuredSeeds.some((seed, index) => seed !== index + 1)
    )
      throw new SchedulingRuleError(
        'Tournament seeds must be unique and consecutive before generation.',
      );
    if (
      bracket.type === 'round_robin_pools' ||
      bracket.type === 'pools_to_bracket'
    ) {
      const pools = await trx
        .selectFrom('pools')
        .select(['id', 'name'])
        .where('org_id', '=', context.orgId)
        .where('bracket_id', '=', bracketId)
        .orderBy('sort_order')
        .orderBy('name')
        .execute();
      if (!pools.length)
        throw new SchedulingRuleError(
          'Create at least one pool before generating its round-robin schedule.',
        );
      const members = await trx
        .selectFrom('pool_members')
        .select(['id', 'pool_id', 'team_season_id', 'external_team_id'])
        .where('org_id', '=', context.orgId)
        .where(
          'pool_id',
          'in',
          pools.map((pool) => pool.id),
        )
        .orderBy('seed')
        .execute();
      const memberIds = members.map(
        (member) => member.team_season_id ?? member.external_team_id ?? '',
      );
      if (
        memberIds.some((memberId) => !memberId) ||
        new Set(memberIds).size !== memberIds.length ||
        memberIds.length !== entrants.length ||
        entrants.some((entrant) => !memberIds.includes(entrant.id)) ||
        pools.some(
          (pool) =>
            members.filter((member) => member.pool_id === pool.id).length < 2,
        )
      )
        throw new SchedulingRuleError(
          'Assign every active tournament entry to exactly one pool with at least two teams.',
        );
      const pairings = roundRobinPoolPairings(
        pools.map((pool) => ({
          id: pool.id,
          members: members
            .filter((member) => member.pool_id === pool.id)
            .map((member) => ({
              id: member.id,
              teamSeasonId: member.team_season_id,
              externalTeamId: member.external_team_id,
            })),
        })),
      );
      const poolNameById = new Map(pools.map((pool) => [pool.id, pool.name]));
      const entrantIds = new Set(entrants.map((entrant) => entrant.id));
      for (const pairing of pairings) {
        if (
          !entrantIds.has(pairing.homeTeamId) ||
          !entrantIds.has(pairing.awayTeamId)
        )
          throw new SchedulingRuleError(
            'Pool members must match active tournament entries.',
            409,
            'CONFLICT',
          );
        const slot = (entrantId: string) => ({
          entrantId,
          sourceMatchId: null,
          sourceOutcome: null,
          bracketKind: 'winners',
          winnerId: null,
          finalized: false,
          poolId: pairing.poolId,
          poolName: poolNameById.get(pairing.poolId),
        });
        await trx
          .insertInto('bracket_matches')
          .values({
            id: newId(),
            org_id: context.orgId,
            bracket_id: bracketId,
            round: pairing.round,
            position: pairing.position,
            participant_a: slot(
              pairing.homeTeamId,
            ) as unknown as import('../../db/types').Json,
            participant_b: slot(
              pairing.awayTeamId,
            ) as unknown as import('../../db/types').Json,
          })
          .execute();
      }
      const updated = await trx
        .updateTable('brackets')
        .set({
          status: 'published',
          version: bracket.version + 1,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', bracketId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new VersionConflictError(bracket);
      return {
        bracket: updated,
        matches: pairings.length,
        size: entrants.length,
        automaticByes: 0,
      };
    }

    let generated: Bracket;
    if (
      bracket.type === 'single_elim' ||
      bracket.type === 'consolation' ||
      bracket.type === 'pools_to_bracket'
    )
      generated = generateSingleElimination(entrants);
    else if (bracket.type === 'double_elim')
      generated = generateDoubleElimination(entrants);
    else
      throw new SchedulingRuleError(
        'This tournament format does not support automatic bracket generation.',
        409,
        'CONFLICT',
      );
    appendThirdPlaceMatch(generated, bracket.third_place);
    await persistBracketMatches(trx, context.orgId, bracketId, generated);
    const updated = await trx
      .updateTable('brackets')
      .set({
        status: 'published',
        size: generated.size,
        version: bracket.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', bracketId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(bracket);
    return {
      bracket: updated,
      matches: generated.matches.length,
      size: generated.size,
      automaticByes: generated.matches.filter((match) => match.finalized)
        .length,
    };
  });
}

export async function setBracketContest(
  context: OrgContext,
  bracketId: string,
  matchId: string,
  contestId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    const bracket = await trx
      .selectFrom('brackets')
      .select(['program_id', 'division_id', 'status', 'type'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', bracketId)
      .executeTakeFirst();
    if (!bracket)
      throw new SchedulingRuleError('Tournament not found.', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'tournaments.manage', {
      programId: bracket.program_id,
      ...(bracket.division_id ? { divisionId: bracket.division_id } : {}),
    });
    const match = await trx
      .selectFrom('bracket_matches')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', matchId)
      .where('bracket_id', '=', bracketId)
      .executeTakeFirst();
    if (!match)
      throw new SchedulingRuleError(
        'Bracket match not found.',
        404,
        'NOT_FOUND',
      );
    if (match.version !== expectedVersion)
      throw new VersionConflictError(match);
    if (match.contest_id)
      throw new SchedulingRuleError(
        'A contest is already attached to this match.',
        409,
        'CONFLICT',
      );
    const contest = await trx
      .selectFrom('contests')
      .select(['id', 'event_id'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', contestId)
      .executeTakeFirst();
    if (!contest)
      throw new SchedulingRuleError('Contest not found.', 404, 'NOT_FOUND');
    const updated = await trx
      .updateTable('bracket_matches')
      .set({ contest_id: contestId, version: match.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', matchId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('contests')
      .set({
        bracket_match_id: matchId,
        ...(bracket.type === 'round_robin_pools' ||
        bracket.type === 'pools_to_bracket'
          ? { stage: 'pool', counts_for_standings: true }
          : { counts_for_standings: false }),
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', contestId)
      .execute();
    await trx
      .updateTable('brackets')
      .set({
        status: 'in_progress',
        version:
          (
            await trx
              .selectFrom('brackets')
              .select('version')
              .where('org_id', '=', context.orgId)
              .where('id', '=', bracketId)
              .executeTakeFirstOrThrow()
          ).version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', bracketId)
      .execute();
    return updated;
  });
}

export async function advanceBracketMatch(
  trx: OrgTransaction,
  orgId: string,
  bracketId: string,
  matchId: string,
  winnerId: string,
): Promise<void> {
  const bracketRow = await trx
    .selectFrom('brackets')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('id', '=', bracketId)
    .executeTakeFirst();
  if (!bracketRow)
    throw new SchedulingRuleError('Bracket not found.', 404, 'NOT_FOUND');
  const rows = await trx
    .selectFrom('bracket_matches')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('bracket_id', '=', bracketId)
    .orderBy('round')
    .orderBy('position')
    .execute();
  const contests = await trx
    .selectFrom('bracket_matches')
    .innerJoin('contests', (join) =>
      join
        .onRef('contests.org_id', '=', 'bracket_matches.org_id')
        .onRef('contests.id', '=', 'bracket_matches.contest_id'),
    )
    .leftJoin('contest_participants', (join) =>
      join
        .onRef('contest_participants.org_id', '=', 'contests.org_id')
        .onRef('contest_participants.contest_id', '=', 'contests.id'),
    )
    .leftJoin('contest_results', (join) =>
      join
        .onRef('contest_results.org_id', '=', 'contest_participants.org_id')
        .onRef(
          'contest_results.contest_participant_id',
          '=',
          'contest_participants.id',
        ),
    )
    .select([
      'contests.id as contest_id',
      'contests.status',
      'bracket_matches.id as match_id',
      'contest_participants.team_season_id',
      'contest_participants.external_team_id',
      'contest_participants.person_id',
      'contest_results.outcome',
    ])
    .where('bracket_matches.org_id', '=', orgId)
    .where('bracket_matches.bracket_id', '=', bracketId)
    .execute();
  const matchById = new Map(rows.map((row) => [row.id, row]));
  const labelById = new Map(rows.map((row) => [row.id, row.id]));
  const matches: BracketMatch[] = rows.map((row) => {
    const a = (row.participant_a ?? {}) as SlotJson;
    const b = (row.participant_b ?? {}) as SlotJson;
    const kind = a.bracketKind ?? b.bracketKind ?? 'winners';
    const winner = contests.find(
      (item) =>
        item.match_id === row.id &&
        ['final', 'forfeit'].includes(item.status) &&
        item.outcome === 'win',
    );
    const winnerEntrant = winner
      ? (winner.team_season_id ?? winner.external_team_id ?? winner.person_id)
      : (a.winnerId ?? b.winnerId ?? null);
    return {
      id: row.id,
      bracket: kind,
      round: row.round,
      position: row.position,
      home: slotFrom(a, labelById),
      away: slotFrom(b, labelById),
      winnerId: winnerEntrant,
      finalized: Boolean(winner) || Boolean(a.finalized),
      winnerTo: row.winner_to_match_id
        ? {
            matchId: row.winner_to_match_id,
            slot: row.winner_to_slot === 'a' ? 'home' : 'away',
          }
        : null,
      loserTo: row.loser_to_match_id
        ? {
            matchId: row.loser_to_match_id,
            slot: row.loser_to_slot === 'a' ? 'home' : 'away',
          }
        : null,
    };
  });
  const targetRow = matchById.get(matchId);
  if (!targetRow)
    throw new SchedulingRuleError('Bracket match not found.', 404, 'NOT_FOUND');
  const finalResult = await trx
    .selectFrom('contests')
    .select('status')
    .where('org_id', '=', orgId)
    .where('id', '=', targetRow.contest_id)
    .executeTakeFirst();
  if (!finalResult || !['final', 'forfeit'].includes(finalResult.status))
    throw new SchedulingRuleError(
      'A bracket can advance only after its contest is final.',
      409,
      'CONFLICT',
    );
  const targetA = (targetRow.participant_a ?? {}) as SlotJson;
  const targetB = (targetRow.participant_b ?? {}) as SlotJson;
  if (
    bracketRow.type === 'pools_to_bracket' &&
    (targetA.poolId || targetB.poolId)
  ) {
    await trx
      .updateTable('bracket_matches')
      .set({
        participant_a: {
          ...targetA,
          winnerId,
          finalized: true,
        } as unknown as import('../../db/types').Json,
        participant_b: {
          ...targetB,
          winnerId,
          finalized: true,
        } as unknown as import('../../db/types').Json,
        version: targetRow.version + 1,
      })
      .where('org_id', '=', orgId)
      .where('id', '=', matchId)
      .where('version', '=', targetRow.version)
      .execute();
    const poolMatches = rows.filter((row) => {
      const slot = (row.participant_a ?? {}) as SlotJson;
      return Boolean(slot.poolId);
    });
    const finalizedPoolMatches = new Set(
      contests
        .filter((item) => ['final', 'forfeit'].includes(item.status))
        .map((item) => item.match_id),
    );
    if (
      poolMatches.some(
        (row) => row.id !== matchId && !finalizedPoolMatches.has(row.id),
      )
    )
      return;
    if (rows.some((row) => !(row.participant_a as SlotJson | null)?.poolId))
      throw new SchedulingRuleError(
        'Pool results cannot be changed after elimination seeding.',
        409,
        'CONFLICT',
      );
    const poolSummaries = await poolStandingsForBracket(
      trx,
      orgId,
      bracketId,
      bracketRow.program_id,
      bracketRow.division_id,
    );
    const rankedEntrants: BracketEntrant[] = poolSummaries.flatMap((pool) =>
      pool.members.flatMap((member) => {
        const id = member.team_season_id ?? member.external_team_id;
        const standing = pool.standings.find((row) => row.teamId === id);
        if (!id || !standing) return [];
        return [
          {
            id,
            seed: standing.rank,
            pool: pool.name,
            poolRank: standing.rank,
            pointsPerGame:
              standing.played > 0 ? standing.points / standing.played : 0,
          },
        ];
      }),
    );
    const poolConfig = (bracketRow.config ?? {}) as {
      poolSeeding?: unknown;
    };
    const seedingMode =
      poolConfig.poolSeeding === 'overall' ? 'overall' : 'cross_pool';
    let seeded: BracketEntrant[];
    try {
      seeded = seedFromPools(rankedEntrants, seedingMode);
    } catch (error) {
      throw new SchedulingRuleError(
        error instanceof Error
          ? error.message
          : 'Pool standings cannot seed the elimination bracket.',
        409,
        'CONFLICT',
      );
    }
    const poolBracket = generateSingleElimination(seeded);
    appendThirdPlaceMatch(poolBracket, bracketRow.third_place);
    const poolRoundOffset = poolMatches.reduce(
      (maximum, row) => Math.max(maximum, row.round),
      0,
    );
    await persistBracketMatches(
      trx,
      orgId,
      bracketId,
      poolBracket,
      poolRoundOffset,
    );
    await bindEliminationReservations(trx, orgId, bracketId);
    await trx
      .updateTable('brackets')
      .set({
        status: 'in_progress',
        size: poolBracket.size,
        version: bracketRow.version + 1,
      })
      .where('org_id', '=', orgId)
      .where('id', '=', bracketId)
      .where('version', '=', bracketRow.version)
      .execute();
    return;
  }
  const poolRowsForOffset =
    bracketRow.type === 'pools_to_bracket'
      ? rows.filter((row) =>
          Boolean((row.participant_a as SlotJson | null)?.poolId),
        )
      : [];
  const poolRoundOffset = poolRowsForOffset.reduce(
    (maximum, row) => Math.max(maximum, row.round),
    0,
  );
  const poolMatchIds = new Set(poolRowsForOffset.map((row) => row.id));
  const advancementMatches = matches
    .filter((match) => !poolMatchIds.has(match.id))
    .map((match) => ({ ...match, round: match.round - poolRoundOffset }));
  const model: Bracket = {
    kind: bracketRow.type === 'double_elim' ? 'double' : 'single',
    size: bracketRow.size,
    matches: advancementMatches,
    resetFinalId:
      advancementMatches.find(
        (match) =>
          match.position === 1 &&
          match.bracket === 'final' &&
          match.round > Math.log2(Math.max(2, bracketRow.size)),
      )?.id ?? null,
  };
  let updated: Bracket;
  try {
    updated = finalizeBracketMatch(model, matchId, winnerId);
  } catch (error) {
    throw new SchedulingRuleError(
      error instanceof Error
        ? error.message
        : 'Bracket result cannot be advanced.',
      409,
      'CONFLICT',
    );
  }
  for (const result of updated.matches) {
    const row = matchById.get(result.id);
    if (!row) continue;
    const previous =
      result.home.entrantId ===
        slotFrom(row.participant_a, labelById).entrantId &&
      result.away.entrantId ===
        slotFrom(row.participant_b, labelById).entrantId;
    if (previous && result.id !== matchId) continue;
    const a = {
      ...result.home,
      bracketKind: result.bracket,
      winnerId: result.winnerId,
      finalized: result.finalized,
    };
    const b = {
      ...result.away,
      bracketKind: result.bracket,
      winnerId: result.winnerId,
      finalized: result.finalized,
    };
    await trx
      .updateTable('bracket_matches')
      .set({
        participant_a: a as unknown as import('../../db/types').Json,
        participant_b: b as unknown as import('../../db/types').Json,
        version: row.version + 1,
      })
      .where('org_id', '=', orgId)
      .where('id', '=', row.id)
      .where('version', '=', row.version)
      .execute();
  }
  if (updated.matches.every((match) => match.finalized))
    await trx
      .updateTable('brackets')
      .set({ status: 'completed', version: bracketRow.version + 1 })
      .where('org_id', '=', orgId)
      .where('id', '=', bracketId)
      .where('version', '=', bracketRow.version)
      .execute();
}

export async function createTournamentPool(
  context: OrgContext,
  bracketId: string,
  name: string,
  members: Array<{ teamSeasonId?: string; externalTeamId?: string }>,
) {
  return withOrg(context, async (trx) => {
    const bracket = await trx
      .selectFrom('brackets')
      .select(['program_id', 'division_id', 'type', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', bracketId)
      .executeTakeFirst();
    if (!bracket)
      throw new SchedulingRuleError('Tournament not found.', 404, 'NOT_FOUND');
    if (!['round_robin_pools', 'pools_to_bracket'].includes(bracket.type))
      throw new SchedulingRuleError(
        'Pools can only be added to a pool tournament.',
        409,
        'CONFLICT',
      );
    if (bracket.status !== 'draft')
      throw new SchedulingRuleError(
        'Pools cannot be changed after tournament generation.',
        409,
        'CONFLICT',
      );
    await assertSchedulePermission(trx, context, 'tournaments.manage', {
      programId: bracket.program_id,
      ...(bracket.division_id ? { divisionId: bracket.division_id } : {}),
    });
    if (
      new Set(
        members.map((member) => member.teamSeasonId ?? member.externalTeamId),
      ).size !== members.length
    )
      throw new SchedulingRuleError('A team can only appear once in a pool.');
    const entries = await trx
      .selectFrom('tournament_entries')
      .select(['id', 'team_season_id', 'external_team_id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('bracket_id', '=', bracketId)
      .where('status', '!=', 'withdrawn')
      .execute();
    const matchedEntries = members.map((member) =>
      entries.find(
        (entry) =>
          (member.teamSeasonId &&
            entry.team_season_id === member.teamSeasonId) ||
          (member.externalTeamId &&
            entry.external_team_id === member.externalTeamId),
      ),
    );
    if (matchedEntries.some((entry) => !entry))
      throw new SchedulingRuleError(
        'Every pool member must be an active entry in this tournament.',
      );
    const alreadyAssigned = await trx
      .selectFrom('pools')
      .innerJoin('pool_members', (join) =>
        join
          .onRef('pool_members.org_id', '=', 'pools.org_id')
          .onRef('pool_members.pool_id', '=', 'pools.id'),
      )
      .select(['pool_members.team_season_id', 'pool_members.external_team_id'])
      .where('pools.org_id', '=', context.orgId)
      .where('pools.bracket_id', '=', bracketId)
      .execute();
    if (
      members.some((member) =>
        alreadyAssigned.some(
          (assigned) =>
            (member.teamSeasonId &&
              assigned.team_season_id === member.teamSeasonId) ||
            (member.externalTeamId &&
              assigned.external_team_id === member.externalTeamId),
        ),
      )
    )
      throw new SchedulingRuleError(
        'A team already belongs to another pool in this tournament.',
        409,
        'CONFLICT',
      );
    const poolId = newId();
    const priorPools = await trx
      .selectFrom('pools')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('bracket_id', '=', bracketId)
      .execute();
    await trx
      .insertInto('pools')
      .values({
        id: poolId,
        org_id: context.orgId,
        bracket_id: bracketId,
        name,
        sort_order: priorPools.length,
      })
      .execute();
    for (const [index, member] of members.entries())
      await trx
        .insertInto('pool_members')
        .values({
          id: newId(),
          org_id: context.orgId,
          pool_id: poolId,
          team_season_id: member.teamSeasonId ?? null,
          external_team_id: member.externalTeamId ?? null,
          person_id: null,
          seed: index + 1,
        })
        .execute();
    return { id: poolId, name, members };
  });
}

export function seedFromPools(
  entrants: BracketEntrant[],
  mode: 'cross_pool' | 'overall',
) {
  return crossSeedPools(entrants, mode);
}
