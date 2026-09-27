import { newId } from '@shared/ids';
import {
  computeBout,
  computeScore,
  computeSets,
  rankJudged,
  rankMeasured,
  rankPlacementOnly,
  rankTimed,
} from '@shared/sport/results';
import type { Placement, RankedEntry } from '@shared/sport/results';
import { contestFormatSchema, sportProfileSchema } from '@shared/sport/schema';
import type { ContestFormatConfig, SportProfile } from '@shared/sport/schema';

import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { VersionConflictError } from '../../lib/version-check';
import { appendAuditEvent } from '../audit/service';
import { assertSchedulePermission } from '../scheduling/access';
import { scopeForEvent, SchedulingRuleError } from '../scheduling/events';

type ContestRecord = {
  id: string;
  org_id: string;
  event_id: string;
  sport_profile_id: string;
  profile_version: number;
  format: string;
  format_config: unknown;
  stage: string;
  counts_for_standings: boolean;
  status: string;
  version: number;
  disputed_at: Date | null;
  bracket_match_id: string | null;
};

type ContestParticipant = {
  id: string;
  contest_id: string;
  team_season_id: string | null;
  external_team_id: string | null;
  person_id: string | null;
  side: string;
  seed: number | null;
  heat: number | null;
  lane: number | null;
  flight: number | null;
};

function numeric(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(result))
    throw new SchedulingRuleError('A score must be a finite number.');
  return result;
}

async function contestBundle(
  trx: OrgTransaction,
  orgId: string,
  contestId: string,
) {
  const contest = (await trx
    .selectFrom('contests')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('id', '=', contestId)
    .executeTakeFirst()) as ContestRecord | undefined;
  if (!contest)
    throw new SchedulingRuleError('Contest not found.', 404, 'NOT_FOUND');
  const event = await trx
    .selectFrom('events')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('id', '=', contest.event_id)
    .executeTakeFirstOrThrow();
  const participants = (await trx
    .selectFrom('contest_participants')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('contest_id', '=', contestId)
    .orderBy('side')
    .execute()) as ContestParticipant[];
  const results = await trx
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
    .selectAll('contest_results')
    .select([
      'contest_participants.id as participant_id',
      'contest_participants.side',
      'contest_participants.team_season_id',
      'contest_participants.person_id',
    ])
    .where('contest_results.org_id', '=', orgId)
    .where('contest_participants.contest_id', '=', contestId)
    .execute();
  const profileVersion = await trx
    .selectFrom('sport_profile_versions')
    .select('profile')
    .where('org_id', '=', orgId)
    .where('sport_profile_id', '=', contest.sport_profile_id)
    .where('version', '=', contest.profile_version)
    .executeTakeFirst();
  if (!profileVersion)
    throw new SchedulingRuleError(
      'The contest sport profile version is unavailable.',
      409,
      'CONFLICT',
    );
  const profile = sportProfileSchema.parse(profileVersion.profile);
  const format = contest.format_config
    ? contestFormatSchema.parse(contest.format_config)
    : profile.contestFormats.find((item) => item.format === contest.format);
  if (!format)
    throw new SchedulingRuleError(
      'The contest format snapshot is unavailable.',
      409,
      'CONFLICT',
    );
  return { contest, event, participants, results, profile, format };
}

export async function createContest(
  context: OrgContext,
  eventId: string,
  input: {
    formatIndex: number;
    stage: 'regular' | 'pool' | 'playoff' | 'tournament' | 'friendly';
    countsForStandings: boolean;
  },
) {
  return withOrg(context, async (trx) => {
    const scope = await scopeForEvent(trx, context.orgId, eventId);
    if (!scope)
      throw new SchedulingRuleError('Event not found.', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'results.manage', scope);
    const event = await trx
      .selectFrom('events')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    if (!event.program_id)
      throw new SchedulingRuleError(
        'A contest requires an event linked to a program.',
      );
    const program = await trx
      .selectFrom('programs')
      .select('sport_profile_id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', event.program_id)
      .executeTakeFirstOrThrow();
    const sportProfile = await trx
      .selectFrom('sport_profiles')
      .select(['id', 'version'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', program.sport_profile_id)
      .executeTakeFirstOrThrow();
    const profileVersion = await trx
      .selectFrom('sport_profile_versions')
      .select('profile')
      .where('org_id', '=', context.orgId)
      .where('sport_profile_id', '=', sportProfile.id)
      .where('version', '=', sportProfile.version)
      .executeTakeFirst();
    if (!profileVersion)
      throw new SchedulingRuleError(
        'The current sport profile version is unavailable.',
        409,
        'CONFLICT',
      );
    const profile = sportProfileSchema.parse(profileVersion.profile);
    const format = profile.contestFormats[input.formatIndex];
    if (!format)
      throw new SchedulingRuleError(
        'Choose a contest format from the sport profile.',
      );
    const existing = await trx
      .selectFrom('contests')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    if (existing)
      throw new SchedulingRuleError(
        'A contest already exists for this event.',
        409,
        'CONFLICT',
      );
    const contestId = newId();
    await trx
      .insertInto('contests')
      .values({
        id: contestId,
        org_id: context.orgId,
        event_id: eventId,
        sport_profile_id: sportProfile.id,
        profile_version: sportProfile.version,
        format: format.format,
        format_config: format as unknown as import('../../db/types').Json,
        stage: input.stage,
        counts_for_standings: input.countsForStandings,
      })
      .execute();
    const eventParticipants = await trx
      .selectFrom('event_participants')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .execute();
    for (const participant of eventParticipants) {
      if (
        participant.team_season_id ||
        participant.external_team_id ||
        participant.person_id
      ) {
        await trx
          .insertInto('contest_participants')
          .values({
            id: newId(),
            org_id: context.orgId,
            contest_id: contestId,
            team_season_id: participant.team_season_id,
            external_team_id: participant.external_team_id,
            person_id: participant.person_id,
            side: participant.side,
          })
          .execute();
      }
    }
    await appendAuditEvent(trx, context, {
      action: 'contest.create',
      entityType: 'contest',
      entityId: contestId,
    });
    return {
      id: contestId,
      eventId,
      sportProfileId: sportProfile.id,
      profileVersion: sportProfile.version,
      format,
      status: 'scheduled',
      version: 1,
    };
  });
}

export async function assignMeetParticipants(
  context: OrgContext,
  contestId: string,
  input: {
    expectedVersion: number;
    assignments: Array<{
      participantId: string;
      seed: number;
      heat: number;
      lane: number;
    }>;
  },
) {
  return withOrg(context, async (trx) => {
    const bundle = await contestBundle(trx, context.orgId, contestId);
    const scope = await scopeForEvent(
      trx,
      context.orgId,
      bundle.contest.event_id,
    );
    if (!scope)
      throw new SchedulingRuleError('Event not found.', 404, 'NOT_FOUND');
    await assertSchedulePermission(trx, context, 'results.manage', scope);
    if (bundle.contest.version !== input.expectedVersion)
      throw new VersionConflictError(bundle.contest);
    if (!['scheduled', 'in_progress'].includes(bundle.contest.status))
      throw new SchedulingRuleError(
        'Meet lanes cannot change after a result is final.',
        409,
        'CONFLICT',
      );
    if (bundle.format.format !== 'multi_timed')
      throw new SchedulingRuleError(
        'Heat and lane assignments are only available for timed meets.',
      );
    if (
      !bundle.participants.length ||
      input.assignments.length !== bundle.participants.length ||
      new Set(input.assignments.map((item) => item.participantId)).size !==
        input.assignments.length ||
      input.assignments.some(
        (item) =>
          !bundle.participants.some(
            (participant) => participant.id === item.participantId,
          ),
      )
    )
      throw new SchedulingRuleError(
        'Assign every meet participant exactly once.',
      );
    const occupied = new Set<string>();
    const seeds = new Set<number>();
    for (const assignment of input.assignments) {
      const cell = `${String(assignment.heat)}:${String(assignment.lane)}`;
      if (
        !Number.isSafeInteger(assignment.seed) ||
        assignment.seed < 1 ||
        !Number.isSafeInteger(assignment.heat) ||
        assignment.heat < 1 ||
        !Number.isSafeInteger(assignment.lane) ||
        assignment.lane < 1 ||
        assignment.lane > bundle.format.lanes ||
        (!bundle.format.heats && assignment.heat !== 1) ||
        occupied.has(cell) ||
        seeds.has(assignment.seed)
      )
        throw new SchedulingRuleError(
          'Meet seeds and lanes must be unique and within the sport format.',
        );
      occupied.add(cell);
      seeds.add(assignment.seed);
    }
    for (const assignment of input.assignments) {
      await trx
        .updateTable('contest_participants')
        .set({
          seed: assignment.seed,
          heat: assignment.heat,
          lane: assignment.lane,
        })
        .where('org_id', '=', context.orgId)
        .where('contest_id', '=', contestId)
        .where('id', '=', assignment.participantId)
        .execute();
    }
    const updated = await trx
      .updateTable('contests')
      .set({ version: bundle.contest.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', contestId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(bundle.contest);
    await appendAuditEvent(trx, context, {
      action: 'contest.meet.assign',
      entityType: 'contest',
      entityId: contestId,
    });
    return {
      contestId,
      version: updated.version,
      assignments: input.assignments,
    };
  });
}

type ResultInput = {
  home?: number;
  away?: number;
  periods?: Array<{ home: number; away: number }>;
  shootoutWinner?: 'home' | 'away';
  forfeitBy?: 'home' | 'away';
  forfeitScore?: { winner: number; loser: number };
  sets?: Array<{
    home: number;
    away: number;
    tiebreakWinner?: 'home' | 'away';
  }>;
  winner?: 'home' | 'away';
  method?: string;
  entries?: Array<{
    participantId: string;
    value?: number;
    place?: number;
    attempts?: number[];
    status?: 'ok' | 'dq' | 'dnf' | 'dns';
    relay?: boolean;
    sheets?: Array<{ judgeId: string; components: Record<string, number> }>;
  }>;
  stats?: Array<{ participantId: string; statKey: string; value: number }>;
  cards?: Array<{ personId: string; type: string; description?: string }>;
  abandoned?: boolean;
};

type ComputedRow = {
  participantId: string;
  score: number | null;
  place: number | null;
  outcome: 'win' | 'loss' | 'tie' | 'none';
  status: string;
  points: number | null;
  detail: Record<string, unknown>;
};

function computeResultRows(
  format: ContestFormatConfig,
  participants: readonly ContestParticipant[],
  input: ResultInput,
  bracket: boolean,
): ComputedRow[] {
  const bySide = new Map(participants.map((item) => [item.side, item]));
  const homeParticipant = bySide.get('home');
  const awayParticipant = bySide.get('away');
  if (format.format === 'head_to_head_score') {
    if (!homeParticipant || !awayParticipant)
      throw new SchedulingRuleError(
        'Score contests require home and away participants.',
      );
    const result = computeScore(
      format,
      numeric(input.home),
      numeric(input.away),
      {
        bracket,
        ...(input.periods ? { periods: input.periods } : {}),
        ...(input.shootoutWinner
          ? { shootoutWinner: input.shootoutWinner }
          : {}),
        ...(input.forfeitBy ? { forfeitBy: input.forfeitBy } : {}),
        ...(input.forfeitScore ? { forfeitScore: input.forfeitScore } : {}),
      },
    );
    return [
      {
        participantId: homeParticipant.id,
        score: result.home,
        place: null,
        outcome:
          result.outcome === 'tie'
            ? 'tie'
            : result.winner === 'home'
              ? 'win'
              : 'loss',
        status:
          input.forfeitBy === 'home'
            ? 'forfeit_loss'
            : input.forfeitBy === 'away'
              ? 'forfeit_win'
              : 'ok',
        points: null,
        detail: {
          periods: input.periods ?? [],
          shootoutWinner: result.shootoutWinner,
          ...(input.forfeitBy ? { forfeitBy: input.forfeitBy } : {}),
        },
      },
      {
        participantId: awayParticipant.id,
        score: result.away,
        place: null,
        outcome:
          result.outcome === 'tie'
            ? 'tie'
            : result.winner === 'away'
              ? 'win'
              : 'loss',
        status:
          input.forfeitBy === 'away'
            ? 'forfeit_loss'
            : input.forfeitBy === 'home'
              ? 'forfeit_win'
              : 'ok',
        points: null,
        detail: {
          periods: input.periods ?? [],
          shootoutWinner: result.shootoutWinner,
          ...(input.forfeitBy ? { forfeitBy: input.forfeitBy } : {}),
        },
      },
    ];
  }
  if (format.format === 'head_to_head_sets') {
    if (!homeParticipant || !awayParticipant || !input.sets)
      throw new SchedulingRuleError(
        'Set contests require a complete set score.',
      );
    const result = computeSets(format, input.sets);
    return [
      {
        participantId: homeParticipant.id,
        score: result.homePoints,
        place: null,
        outcome: result.winner === 'home' ? 'win' : 'loss',
        status: 'ok',
        points: null,
        detail: {
          sets: input.sets,
          setsWon: result.homeSets,
          opponentSetsWon: result.awaySets,
        },
      },
      {
        participantId: awayParticipant.id,
        score: result.awayPoints,
        place: null,
        outcome: result.winner === 'away' ? 'win' : 'loss',
        status: 'ok',
        points: null,
        detail: {
          sets: input.sets,
          setsWon: result.awaySets,
          opponentSetsWon: result.homeSets,
        },
      },
    ];
  }
  if (format.format === 'head_to_head_bout') {
    if (!homeParticipant || !awayParticipant || !input.winner || !input.method)
      throw new SchedulingRuleError(
        'Bout contests require a winner and method.',
      );
    const result = computeBout(format, input.winner, input.method);
    return [
      {
        participantId: homeParticipant.id,
        score: result.homeTeamPoints,
        place: null,
        outcome: result.winner === 'home' ? 'win' : 'loss',
        status: 'ok',
        points: null,
        detail: { method: result.method },
      },
      {
        participantId: awayParticipant.id,
        score: result.awayTeamPoints,
        place: null,
        outcome: result.winner === 'away' ? 'win' : 'loss',
        status: 'ok',
        points: null,
        detail: { method: result.method },
      },
    ];
  }
  if (!input.entries?.length)
    throw new SchedulingRuleError('Enter at least one participant result.');
  const known = new Map(participants.map((item) => [item.id, item]));
  const ids = input.entries.map((entry) => entry.participantId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !known.has(id)))
    throw new SchedulingRuleError(
      'Result entries must refer to distinct contest participants.',
    );
  let placements: Placement[];
  if (format.format === 'multi_timed') {
    const ranked: RankedEntry[] = input.entries.map((entry) => ({
      id: entry.participantId,
      value: numeric(entry.value),
      ...(known.get(entry.participantId)?.team_season_id
        ? { teamId: known.get(entry.participantId)?.team_season_id as string }
        : {}),
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.relay === undefined ? {} : { relay: entry.relay }),
    }));
    placements = rankTimed(format, ranked);
  } else if (format.format === 'multi_measured') {
    placements = rankMeasured(
      format,
      input.entries.map((entry) => ({
        id: entry.participantId,
        attempts: entry.attempts ?? [],
        ...(known.get(entry.participantId)?.team_season_id
          ? { teamId: known.get(entry.participantId)?.team_season_id as string }
          : {}),
        ...(entry.status ? { status: entry.status } : {}),
      })),
    );
  } else if (format.format === 'judged') {
    placements = rankJudged(
      format,
      input.entries.map((entry) => ({
        id: entry.participantId,
        sheets: entry.sheets ?? [],
        ...(known.get(entry.participantId)?.team_season_id
          ? { teamId: known.get(entry.participantId)?.team_season_id as string }
          : {}),
      })),
    );
  } else {
    placements = rankPlacementOnly(
      input.entries.map((entry) => ({
        id: entry.participantId,
        place: entry.place ?? 0,
        ...(known.get(entry.participantId)?.team_season_id
          ? { teamId: known.get(entry.participantId)?.team_season_id as string }
          : {}),
      })),
      format.placePoints,
    );
  }
  const firstPlaceIds = placements
    .filter((item) => item.place === 1)
    .map((item) => item.id);
  return placements.map((item) => ({
    participantId: item.id,
    score: item.value,
    place: item.place,
    outcome:
      item.place === null
        ? 'none'
        : firstPlaceIds.length > 1 && item.place === 1
          ? 'tie'
          : item.place === 1
            ? 'win'
            : 'loss',
    status: item.status,
    points: item.points,
    detail: {
      ...(input.entries?.find((entry) => entry.participantId === item.id) ??
        {}),
      value: item.value,
    },
  }));
}

async function canManageContestTeam(
  trx: OrgTransaction,
  context: OrgContext,
  programId: string | null,
  divisionId: string | null,
  teamIds: readonly (string | null)[],
): Promise<boolean> {
  try {
    await assertSchedulePermission(trx, context, 'results.manage', {
      ...(programId ? { programId } : {}),
      ...(divisionId ? { divisionId } : {}),
    });
    return true;
  } catch {
    /* Check the scoped team assignments next. */
  }
  for (const teamId of teamIds) {
    if (!teamId) continue;
    try {
      await assertSchedulePermission(trx, context, 'results.manage', {
        teamSeasonId: teamId,
      });
      return true;
    } catch {
      /* This actor does not manage this participant's team. */
    }
  }
  return false;
}

async function replaceContestResults(
  trx: OrgTransaction,
  orgId: string,
  rows: readonly ComputedRow[],
): Promise<void> {
  for (const row of rows) {
    const existing = await trx
      .selectFrom('contest_results')
      .select(['id', 'version'])
      .where('org_id', '=', orgId)
      .where('contest_participant_id', '=', row.participantId)
      .executeTakeFirst();
    if (existing) {
      await trx
        .updateTable('contest_results')
        .set({
          score: row.score,
          place: row.place,
          outcome: row.outcome,
          status: row.status,
          points_awarded: row.points,
          score_detail: row.detail as unknown as import('../../db/types').Json,
          version: existing.version + 1,
        })
        .where('org_id', '=', orgId)
        .where('id', '=', existing.id)
        .where('version', '=', existing.version)
        .execute();
    } else {
      await trx
        .insertInto('contest_results')
        .values({
          id: newId(),
          org_id: orgId,
          contest_participant_id: row.participantId,
          score: row.score,
          place: row.place,
          outcome: row.outcome,
          status: row.status,
          points_awarded: row.points,
          score_detail: row.detail as unknown as import('../../db/types').Json,
        })
        .execute();
    }
  }
}

async function updateStatLines(
  trx: OrgTransaction,
  orgId: string,
  contestId: string,
  participants: readonly ContestParticipant[],
  stats: ResultInput['stats'],
  profile: SportProfile,
): Promise<void> {
  if (!stats?.length) return;
  const participantById = new Map(
    participants.map((participant) => [participant.id, participant]),
  );
  const definitions = new Map(
    profile.stats.map((definition) => [definition.key, definition]),
  );
  for (const stat of stats) {
    const participant = participantById.get(stat.participantId);
    if (!participant)
      throw new SchedulingRuleError(
        'Stat entry references an unknown participant.',
      );
    const definition = definitions.get(stat.statKey);
    const targetId =
      definition?.level === 'athlete'
        ? participant.person_id
        : participant.team_season_id;
    if (
      !definition ||
      !targetId ||
      !Number.isFinite(stat.value) ||
      stat.value < 0
    )
      throw new SchedulingRuleError(
        'Stat entry does not match an enabled sport statistic and participant.',
      );
    if (definition.valueType === 'integer' && !Number.isSafeInteger(stat.value))
      throw new SchedulingRuleError(
        `Statistic ${stat.statKey} must be a whole number.`,
      );
    const existing = await trx
      .selectFrom('stat_lines')
      .select(['id', 'version'])
      .where('org_id', '=', orgId)
      .where('contest_id', '=', contestId)
      .where('person_id', '=', participant.person_id)
      .where('team_season_id', '=', participant.team_season_id)
      .where('stat_key', '=', stat.statKey)
      .executeTakeFirst();
    if (existing)
      await trx
        .updateTable('stat_lines')
        .set({ value: stat.value, version: existing.version + 1 })
        .where('org_id', '=', orgId)
        .where('id', '=', existing.id)
        .execute();
    else
      await trx
        .insertInto('stat_lines')
        .values({
          id: newId(),
          org_id: orgId,
          contest_id: contestId,
          person_id: participant.person_id,
          team_season_id: participant.team_season_id,
          stat_key: stat.statKey,
          value: stat.value,
        })
        .execute();
  }
}

export async function submitContestResult(
  context: OrgContext,
  contestId: string,
  input: {
    expectedVersion: number;
    result: ResultInput;
    finalize: boolean;
    correctionReason?: string;
  },
) {
  return withOrg(context, async (trx) => {
    const bundle = await contestBundle(trx, context.orgId, contestId);
    const scope = await scopeForEvent(
      trx,
      context.orgId,
      bundle.contest.event_id,
    );
    const teamIds = bundle.participants.map(
      (participant) => participant.team_season_id,
    );
    if (
      !scope ||
      !(await canManageContestTeam(
        trx,
        context,
        bundle.event.program_id,
        bundle.event.division_id,
        teamIds,
      ))
    )
      throw new SchedulingRuleError(
        'You cannot enter this contest result.',
        403,
        'FORBIDDEN',
      );
    if (bundle.contest.version !== input.expectedVersion)
      throw new VersionConflictError(bundle.contest);
    if (['canceled', 'abandoned'].includes(bundle.contest.status))
      throw new SchedulingRuleError(
        'Canceled or abandoned contests cannot accept a score.',
        409,
        'CONFLICT',
      );
    if (
      ['final', 'forfeit'].includes(bundle.contest.status) &&
      !input.correctionReason
    )
      throw new SchedulingRuleError(
        'A reason is required to correct a finalized result.',
      );
    const beforeState = {
      status: bundle.contest.status,
      results: bundle.results,
    };
    const bracket = Boolean(bundle.contest.bracket_match_id);
    const computed = input.result.abandoned
      ? []
      : computeResultRows(
          bundle.format,
          bundle.participants,
          input.result,
          bracket,
        );
    await replaceContestResults(trx, context.orgId, computed);
    await updateStatLines(
      trx,
      context.orgId,
      contestId,
      bundle.participants,
      input.result.stats,
      bundle.profile,
    );
    let status = input.result.abandoned
      ? 'abandoned'
      : input.result.forfeitBy
        ? 'forfeit'
        : 'in_progress';
    let finalizedAt: Date | null = null;
    let resultConfirmedBy: string | null = null;
    let resultEnteredBy = context.actor.accountId;
    if (input.finalize && !input.result.abandoned) {
      const settings = bundle.event.program_id
        ? await trx
            .selectFrom('schedule_settings')
            .select('result_confirmation_required')
            .where('org_id', '=', context.orgId)
            .where('program_id', '=', bundle.event.program_id)
            .executeTakeFirst()
        : null;
      const scheduler = await (async () => {
        try {
          await assertSchedulePermission(
            trx,
            context,
            'schedule.manage',
            scope,
          );
          return true;
        } catch {
          return false;
        }
      })();
      const existingEnteredBy =
        bundle.contest.status === 'in_progress'
          ? await trx
              .selectFrom('contests')
              .select('result_entered_by')
              .where('org_id', '=', context.orgId)
              .where('id', '=', contestId)
              .executeTakeFirst()
          : null;
      if (
        settings?.result_confirmation_required &&
        !scheduler &&
        existingEnteredBy?.result_entered_by &&
        existingEnteredBy.result_entered_by !== context.actor.accountId
      ) {
        resultEnteredBy = existingEnteredBy.result_entered_by;
        resultConfirmedBy = context.actor.accountId;
        status = input.result.forfeitBy ? 'forfeit' : 'final';
        finalizedAt = new Date();
      } else if (settings?.result_confirmation_required && !scheduler) {
        status = input.result.forfeitBy ? 'forfeit' : 'in_progress';
      } else {
        status = input.result.forfeitBy ? 'forfeit' : 'final';
        finalizedAt = new Date();
        resultConfirmedBy = context.actor.accountId;
      }
    }
    const updated = await trx
      .updateTable('contests')
      .set({
        status,
        result_entered_by: resultEnteredBy,
        result_confirmed_by: resultConfirmedBy,
        finalized_at: finalizedAt,
        version: bundle.contest.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', contestId)
      .where('version', '=', input.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(bundle.contest);
    const afterState = {
      status,
      results: computed,
      stats: input.result.stats ?? [],
    };
    await trx
      .insertInto('result_audit')
      .values({
        id: newId(),
        org_id: context.orgId,
        contest_id: contestId,
        actor_account_id: context.actor.accountId,
        before_state: beforeState as unknown as import('../../db/types').Json,
        after_state: afterState as unknown as import('../../db/types').Json,
        reason: input.correctionReason ?? null,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action:
        status === 'final' || status === 'forfeit'
          ? 'contest.result.finalize'
          : 'contest.result.submit',
      entityType: 'contest',
      entityId: contestId,
    });
    if (status === 'final' || status === 'forfeit') {
      await finalizeBracketFromResult(
        trx,
        context.orgId,
        updated,
        bundle.participants,
        computed,
      );
      const standings = await import('../standings/service');
      await standings.recomputeStandingsForEvent(
        trx,
        context,
        bundle.event.program_id,
        bundle.event.division_id,
      );
      await createDisciplineRecordsForCards(
        trx,
        context,
        contestId,
        input.result.cards ?? [],
        bundle.profile,
      );
    }
    return {
      id: contestId,
      status,
      version: updated.version,
      finalizedAt: finalizedAt?.toISOString() ?? null,
      pendingOpponentConfirmation: input.finalize && status === 'in_progress',
    };
  });
}

async function finalizeBracketFromResult(
  trx: OrgTransaction,
  orgId: string,
  contest: ContestRecord,
  participants: readonly ContestParticipant[],
  results: readonly ComputedRow[],
): Promise<void> {
  const match = await trx
    .selectFrom('bracket_matches')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('contest_id', '=', contest.id)
    .executeTakeFirst();
  if (!match) return;
  const winnerParticipantId = results.find(
    (result) => result.outcome === 'win',
  )?.participantId;
  const winner = participants.find(
    (participant) => participant.id === winnerParticipantId,
  );
  const winnerId =
    winner?.team_season_id ?? winner?.external_team_id ?? winner?.person_id;
  if (!winnerId) return;
  const tournamentService = await import('../tournaments/service');
  await tournamentService.advanceBracketMatch(
    trx,
    orgId,
    match.bracket_id,
    match.id,
    winnerId,
  );
}

async function createDisciplineRecordsForCards(
  trx: OrgTransaction,
  context: OrgContext,
  contestId: string,
  cards: NonNullable<ResultInput['cards']>,
  profile: SportProfile,
): Promise<void> {
  if (!cards.length) return;
  const disciplineServicePath: string = '../discipline/service';
  let discipline: {
    createFromContestResult: (
      trx: OrgTransaction,
      context: OrgContext,
      input: {
        contestId: string;
        personId: string;
        type: string;
        description: string;
        suspensionGames: number;
      },
    ) => Promise<unknown>;
  };
  try {
    discipline = (await import(disciplineServicePath)) as typeof discipline;
  } catch {
    throw new SchedulingRuleError(
      'Discipline cards cannot be finalized until Track F discipline integration is available.',
      503,
      'SCHEDULE_CONFLICT',
    );
  }
  for (const card of cards) {
    const rule = profile.disciplineTypes.find((item) => item.key === card.type);
    if (!rule)
      throw new SchedulingRuleError(`Unknown discipline type: ${card.type}`);
    await discipline.createFromContestResult(trx, context, {
      contestId,
      personId: card.personId,
      type: card.type,
      description: card.description ?? rule.label.en,
      suspensionGames: rule.defaultSuspensionGames,
    });
  }
}

export async function contestDetail(context: OrgContext, contestId: string) {
  return withOrg(context, async (trx) => {
    const bundle = await contestBundle(trx, context.orgId, contestId);
    const scope = await scopeForEvent(
      trx,
      context.orgId,
      bundle.contest.event_id,
    );
    let permitted = false;
    if (scope) {
      try {
        await assertSchedulePermission(trx, context, 'results.read', scope);
        permitted = true;
      } catch {
        /* A linked family member or rostered participant may read through person-scoped access. */
      }
      if (!permitted) {
        try {
          await assertSchedulePermission(trx, context, 'results.manage', scope);
          permitted = true;
        } catch {
          /* Coaches can read the contest for their assigned team. */
        }
      }
    }
    if (!permitted)
      for (const participant of bundle.participants) {
        const participantScope = participant.person_id
          ? { personId: participant.person_id }
          : participant.team_season_id
            ? { teamSeasonId: participant.team_season_id }
            : {};
        try {
          await assertSchedulePermission(
            trx,
            context,
            'results.read',
            participantScope,
          );
          permitted = true;
          break;
        } catch {
          if (participant.team_season_id) {
            try {
              await assertSchedulePermission(trx, context, 'results.manage', {
                teamSeasonId: participant.team_season_id,
              });
              permitted = true;
              break;
            } catch {
              /* Continue until a permitted participant scope is found. */
            }
          }
        }
      }
    if (!permitted)
      throw new SchedulingRuleError(
        'You cannot read this contest.',
        403,
        'FORBIDDEN',
      );
    return {
      contest: bundle.contest,
      event: bundle.event,
      participants: bundle.participants,
      results: bundle.results,
      format: bundle.format,
      profileVersion: bundle.contest.profile_version,
    };
  });
}

export async function confirmContestResult(
  context: OrgContext,
  contestId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    const bundle = await contestBundle(trx, context.orgId, contestId);
    if (bundle.contest.version !== expectedVersion)
      throw new VersionConflictError(bundle.contest);
    if (bundle.contest.status !== 'in_progress')
      throw new SchedulingRuleError(
        'Only a submitted result can be confirmed.',
        409,
        'CONFLICT',
      );
    const enteredBy = await trx
      .selectFrom('contests')
      .select('result_entered_by')
      .where('org_id', '=', context.orgId)
      .where('id', '=', contestId)
      .executeTakeFirstOrThrow();
    if (enteredBy.result_entered_by === context.actor.accountId)
      throw new SchedulingRuleError(
        'A different authorized person must confirm this result.',
        403,
        'FORBIDDEN',
      );
    const canManage = await canManageContestTeam(
      trx,
      context,
      bundle.event.program_id,
      bundle.event.division_id,
      bundle.participants.map((participant) => participant.team_season_id),
    );
    if (!canManage)
      throw new SchedulingRuleError(
        'You cannot confirm this contest result.',
        403,
        'FORBIDDEN',
      );
    const settings = bundle.event.program_id
      ? await trx
          .selectFrom('schedule_settings')
          .select('result_confirmation_required')
          .where('org_id', '=', context.orgId)
          .where('program_id', '=', bundle.event.program_id)
          .executeTakeFirst()
      : null;
    if (!settings?.result_confirmation_required)
      throw new SchedulingRuleError(
        'Opponent confirmation is not enabled for this program.',
        409,
        'CONFLICT',
      );
    const updated = await trx
      .updateTable('contests')
      .set({
        status: 'final',
        finalized_at: new Date(),
        result_confirmed_by: context.actor.accountId,
        version: bundle.contest.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', contestId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(bundle.contest);
    await appendAuditEvent(trx, context, {
      action: 'contest.result.confirm',
      entityType: 'contest',
      entityId: contestId,
    });
    const persistedResults: ComputedRow[] = bundle.results.map((row) => ({
      participantId: row.participant_id,
      score: row.score,
      place: row.place,
      outcome: row.outcome as ComputedRow['outcome'],
      status: row.status,
      points: row.points_awarded,
      detail: row.score_detail as Record<string, unknown>,
    }));
    await finalizeBracketFromResult(
      trx,
      context.orgId,
      updated,
      bundle.participants,
      persistedResults,
    );
    const standings = await import('../standings/service');
    await standings.recomputeStandingsForEvent(
      trx,
      context,
      bundle.event.program_id,
      bundle.event.division_id,
    );
    return { id: contestId, status: updated.status, version: updated.version };
  });
}

export async function disputeContestResult(
  context: OrgContext,
  contestId: string,
  input: { reason: string; expectedVersion: number },
) {
  return withOrg(context, async (trx) => {
    const bundle = await contestBundle(trx, context.orgId, contestId);
    await assertSchedulePermission(
      trx,
      context,
      'results.manage',
      (await scopeForEvent(trx, context.orgId, bundle.contest.event_id)) ?? {},
    );
    if (bundle.contest.version !== input.expectedVersion)
      throw new VersionConflictError(bundle.contest);
    if (!['final', 'forfeit'].includes(bundle.contest.status))
      throw new SchedulingRuleError(
        'Only finalized results can be disputed.',
        409,
        'CONFLICT',
      );
    const updated = await trx
      .updateTable('contests')
      .set({
        disputed_at: new Date(),
        disputed_by: context.actor.accountId,
        dispute_reason: input.reason,
        version: bundle.contest.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', contestId)
      .where('version', '=', input.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(bundle.contest);
    await appendAuditEvent(trx, context, {
      action: 'contest.result.dispute',
      entityType: 'contest',
      entityId: contestId,
      changes: { reason: { tier: 'internal', after: input.reason } },
    });
    return {
      id: contestId,
      disputedAt: updated.disputed_at?.toISOString() ?? null,
      version: updated.version,
    };
  });
}

export async function listContestResults(context: OrgContext, eventId: string) {
  return withOrg(context, async (trx) => {
    const scope = await scopeForEvent(trx, context.orgId, eventId);
    if (!scope)
      throw new SchedulingRuleError('Event not found.', 404, 'NOT_FOUND');
    const contest = await trx
      .selectFrom('contests')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    if (!contest) return null;
    try {
      await assertSchedulePermission(trx, context, 'results.read', scope);
    } catch {
      const participants = await trx
        .selectFrom('contest_participants')
        .select(['team_season_id', 'person_id'])
        .where('org_id', '=', context.orgId)
        .where('contest_id', '=', contest.id)
        .execute();
      let permitted = false;
      for (const participant of participants) {
        const participantScope = participant.person_id
          ? { personId: participant.person_id }
          : participant.team_season_id
            ? { teamSeasonId: participant.team_season_id }
            : {};
        try {
          await assertSchedulePermission(
            trx,
            context,
            'results.read',
            participantScope,
          );
          permitted = true;
          break;
        } catch {
          if (participant.team_season_id) {
            try {
              await assertSchedulePermission(trx, context, 'results.manage', {
                teamSeasonId: participant.team_season_id,
              });
              permitted = true;
              break;
            } catch {
              /* Try the next contest participant. */
            }
          }
        }
      }
      if (!permitted)
        throw new SchedulingRuleError(
          'You cannot read these contest results.',
          403,
          'FORBIDDEN',
        );
    }
    return contestBundle(trx, context.orgId, contest.id);
  });
}

export async function liveContestPublic(orgSlug: string, contestId: string) {
  const { getDatabase } = await import('../../db/kysely');
  const database = getDatabase();
  const organization = await database
    .selectFrom('organizations')
    .select('id')
    .where('slug', '=', orgSlug)
    .executeTakeFirst();
  if (!organization)
    throw new SchedulingRuleError('Contest not found.', 404, 'NOT_FOUND');
  return withOrg(
    { orgId: organization.id, actor: { accountId: newId() } },
    async (trx) => {
      const contest = await trx
        .selectFrom('contests')
        .innerJoin('events', (join) =>
          join
            .onRef('events.org_id', '=', 'contests.org_id')
            .onRef('events.id', '=', 'contests.event_id'),
        )
        .selectAll('contests')
        .where('contests.org_id', '=', organization.id)
        .where('contests.id', '=', contestId)
        .where('events.published', '=', true)
        .executeTakeFirst();
      if (!contest)
        throw new SchedulingRuleError('Contest not found.', 404, 'NOT_FOUND');
      const participants = await trx
        .selectFrom('contest_participants')
        .selectAll()
        .where('org_id', '=', organization.id)
        .where('contest_id', '=', contestId)
        .execute();
      const results = await trx
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
        .selectAll('contest_results')
        .select([
          'contest_participants.side',
          'contest_participants.team_season_id',
        ])
        .where('contest_results.org_id', '=', organization.id)
        .where('contest_participants.contest_id', '=', contestId)
        .execute();
      return {
        contest: {
          id: contest.id,
          status: contest.status,
          finalizedAt: contest.finalized_at,
          version: contest.version,
        },
        participants: participants.map((participant) => ({
          id: participant.id,
          side: participant.side,
          teamSeasonId: participant.team_season_id,
        })),
        results: results.map((result) => ({
          side: result.side,
          score: result.score,
          place: result.place,
          outcome: result.outcome,
          status: result.status,
          scoreDetail: result.score_detail,
        })),
      };
    },
  );
}

export async function listTeamStats(
  context: OrgContext,
  scope: { teamSeasonId: string; statKey?: string },
) {
  return withOrg(context, async (trx) => {
    try {
      await assertSchedulePermission(trx, context, 'results.read', {
        teamSeasonId: scope.teamSeasonId,
      });
    } catch {
      await assertSchedulePermission(trx, context, 'results.manage', {
        teamSeasonId: scope.teamSeasonId,
      });
    }
    const team = await trx
      .selectFrom('team_seasons')
      .innerJoin('programs', (join) =>
        join
          .onRef('programs.org_id', '=', 'team_seasons.org_id')
          .onRef('programs.id', '=', 'team_seasons.program_id'),
      )
      .innerJoin('sport_profiles', (join) =>
        join
          .onRef('sport_profiles.org_id', '=', 'programs.org_id')
          .onRef('sport_profiles.id', '=', 'programs.sport_profile_id'),
      )
      .select(['team_seasons.program_id', 'sport_profiles.profile'])
      .where('team_seasons.org_id', '=', context.orgId)
      .where('team_seasons.id', '=', scope.teamSeasonId)
      .executeTakeFirstOrThrow();
    const profile = sportProfileSchema.parse(team.profile);
    const permitted = new Set(
      profile.stats
        .filter((item) => item.level === 'team' && item.public)
        .map((item) => item.key),
    );
    if (scope.statKey && !permitted.has(scope.statKey))
      throw new SchedulingRuleError(
        'The requested statistic is not public.',
        404,
        'NOT_FOUND',
      );
    let query = trx
      .selectFrom('stat_lines')
      .select(['stat_key', 'value', 'contest_id'])
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', scope.teamSeasonId)
      .where('stat_key', 'in', [...permitted]);
    if (scope.statKey) query = query.where('stat_key', '=', scope.statKey);
    return {
      stats: await query.execute(),
      definitions: profile.stats.filter(
        (item) => item.level === 'team' && item.public,
      ),
    };
  });
}
