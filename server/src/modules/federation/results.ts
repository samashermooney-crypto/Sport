import { newId } from '@shared/ids';
import type { StandingsConfig } from '@shared/sport/schema';
import {
  computeStandings,
  type StandingContest,
  type StandingRow,
} from '@shared/sport/standings';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';

import {
  federationConflict,
  federationNotFound,
  federationUnprocessable,
} from './errors';
import {
  assertActiveRelationship,
  getFederationAdminDatabase,
} from './privileged';

interface ResultInput {
  results: readonly {
    externalTeamId: string;
    score?: number | null | undefined;
    outcome?: 'win' | 'loss' | 'tie' | 'none' | undefined;
    status: 'ok' | 'dnf' | 'dns' | 'dq' | 'forfeit_win' | 'forfeit_loss' | 'no_contest';
  }[];
  finalize: boolean;
  reason?: string | undefined;
}

/** Write contest results inside the league org. Callers own the transaction. */
async function writeContestResult(
  trx: Transaction<DB>,
  leagueOrgId: string,
  contestId: string,
  input: ResultInput,
  actorAccountId: string,
): Promise<void> {
  const contest = await trx
    .selectFrom('contests')
    .selectAll()
    .where('org_id', '=', leagueOrgId)
    .where('id', '=', contestId)
    .forUpdate()
    .executeTakeFirst();
  if (!contest) throw federationNotFound('Contest not found');
  if (['canceled', 'abandoned'].includes(contest.status))
    throw federationConflict('Contest is closed');
  const participants = await trx
    .selectFrom('contest_participants')
    .selectAll()
    .where('org_id', '=', leagueOrgId)
    .where('contest_id', '=', contestId)
    .execute();
  const participantByTeam = new Map(
    participants
      .filter((p) => p.external_team_id)
      .map((p) => [p.external_team_id as string, p]),
  );
  const before = await trx
    .selectFrom('contest_results')
    .selectAll()
    .where('org_id', '=', leagueOrgId)
    .where(
      'contest_participant_id',
      'in',
      participants.map((p) => p.id),
    )
    .execute();
  const hasForfeit = input.results.some((row) =>
    ['forfeit_win', 'forfeit_loss'].includes(row.status),
  );
  for (const result of input.results) {
    const participant = participantByTeam.get(result.externalTeamId);
    if (!participant)
      throw federationUnprocessable(
        `Team ${result.externalTeamId} is not a participant`,
      );
    const outcome =
      result.outcome ??
      (result.status === 'forfeit_win'
        ? 'win'
        : result.status === 'forfeit_loss'
          ? 'loss'
          : 'none');
    const existing = before.find(
      (row) => row.contest_participant_id === participant.id,
    );
    if (existing) {
      await trx
        .updateTable('contest_results')
        .set({
          score: result.score ?? null,
          outcome,
          status: result.status,
          version: existing.version + 1,
        })
        .where('id', '=', existing.id)
        .execute();
    } else {
      await trx
        .insertInto('contest_results')
        .values({
          id: newId(),
          org_id: leagueOrgId,
          contest_participant_id: participant.id,
          outcome,
          place: null,
          score: result.score ?? null,
          score_detail: {},
          status: result.status,
          points_awarded: null,
        })
        .execute();
    }
  }
  if (input.finalize) {
    await trx
      .updateTable('contests')
      .set({
        status: hasForfeit ? 'forfeit' : 'final',
        result_confirmed_by: actorAccountId,
        finalized_at: new Date(),
        version: contest.version + 1,
      })
      .where('id', '=', contestId)
      .execute();
  } else {
    await trx
      .updateTable('contests')
      .set({
        status: 'in_progress',
        result_entered_by: actorAccountId,
        version: contest.version + 1,
      })
      .where('id', '=', contestId)
      .execute();
  }
  const after = await trx
    .selectFrom('contest_results')
    .selectAll()
    .where('org_id', '=', leagueOrgId)
    .where(
      'contest_participant_id',
      'in',
      participants.map((p) => p.id),
    )
    .execute();
  await trx
    .insertInto('result_audit')
    .values({
      id: newId(),
      org_id: leagueOrgId,
      contest_id: contestId,
      actor_account_id: actorAccountId,
      before_state: JSON.stringify(before) as never,
      after_state: JSON.stringify(after) as never,
      reason: input.reason ?? null,
    })
    .execute();
}

/** League records a result on its own contest. */
export async function enterLeagueResult(
  database: Kysely<DB>,
  context: OrgContext,
  contestId: string,
  input: ResultInput,
): Promise<{ contestId: string; status: string }> {
  const withOrg = createWithOrg(database);
  await withOrg(context, async (trx) => {
    await writeContestResult(
      trx,
      context.orgId,
      contestId,
      input,
      context.actor.accountId,
    );
    await appendAuditEvent(trx, context, {
      action: 'federation.result.entered',
      entityType: 'contest',
      entityId: contestId,
      changes: {
        finalize: { tier: 'internal', after: input.finalize },
        results: { tier: 'internal', after: input.results.length },
      },
    });
  });
  return { contestId, status: input.finalize ? 'final' : 'in_progress' };
}

/**
 * Home-club result entry. The club must host the linked game OR field a
 * participant team. Writes through the privileged path into the league
 * contest and audits both orgs.
 */
export async function enterHostedResult(
  context: OrgContext,
  linkId: string,
  input: ResultInput,
): Promise<{ contestId: string; status: string }> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.org_id', ${context.orgId}, true)`.execute(
      trx,
    );
    const link = await trx
      .selectFrom('federation_event_links')
      .selectAll()
      .where('id', '=', linkId)
      .where('club_org_id', '=', context.orgId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!link) throw federationNotFound('Hosted game not found');
    await assertActiveRelationship(trx, link.league_org_id, context.orgId);
    const contest = await trx
      .selectFrom('contests')
      .selectAll()
      .where('org_id', '=', link.league_org_id)
      .where('event_id', '=', link.league_event_id)
      .executeTakeFirst();
    if (!contest) throw federationNotFound('Contest not found');
    await writeContestResult(
      trx,
      link.league_org_id,
      contest.id,
      input,
      context.actor.accountId,
    );
    const actor = { accountId: context.actor.accountId };
    await appendAuditEvent(
      trx,
      { orgId: link.league_org_id, actor },
      {
        action: 'federation.result.entered_by_member',
        entityType: 'contest',
        entityId: contest.id,
        changes: {
          memberOrgId: { tier: 'internal', after: context.orgId },
          finalize: { tier: 'internal', after: input.finalize },
        },
      },
    );
    await appendAuditEvent(trx, { orgId: context.orgId, actor }, {
      action: 'federation.result.entered_by_member',
      entityType: 'contest',
      entityId: contest.id,
      changes: {
        leagueOrgId: { tier: 'internal', after: link.league_org_id },
        finalize: { tier: 'internal', after: input.finalize },
      },
    });
    return { contestId: contest.id, status: input.finalize ? 'final' : 'in_progress' };
  });
}

async function standingsConfig(
  trx: Transaction<DB>,
  orgId: string,
  programId: string,
  divisionId: string,
): Promise<StandingsConfig> {
  const override = await trx
    .selectFrom('standings_configs')
    .select('config')
    .where('org_id', '=', orgId)
    .where('program_id', '=', programId)
    .where((eb) =>
      eb.or([eb('division_id', '=', divisionId), eb('division_id', 'is', null)]),
    )
    .executeTakeFirst();
  if (override) return override.config as StandingsConfig;
  const program = await trx
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
  const profile = program.profile as { defaultStandings?: StandingsConfig };
  if (!profile.defaultStandings)
    throw federationUnprocessable('Sport profile has no standings config');
  return profile.defaultStandings;
}

interface ProgramContestData {
  divisions: { id: string; name: string; teamIds: string[] }[];
  contests: StandingContest[];
}

async function collectProgramContests(
  trx: Transaction<DB>,
  leagueOrgId: string,
  programId: string,
): Promise<ProgramContestData> {
  const divisions = await trx
    .selectFrom('divisions')
    .select(['id', 'name'])
    .where('org_id', '=', leagueOrgId)
    .where('program_id', '=', programId)
    .orderBy('sort_order')
    .execute();
  const entries = await trx
    .selectFrom('team_entries')
    .select(['division_id', 'external_team_id'])
    .where('org_id', '=', leagueOrgId)
    .where('program_id', '=', programId)
    .where('status', '=', 'accepted')
    .execute();
  const contests = await trx
    .selectFrom('contests')
    .innerJoin('events', (join) =>
      join
        .onRef('events.org_id', '=', 'contests.org_id')
        .onRef('events.id', '=', 'contests.event_id'),
    )
    .select([
      'contests.id',
      'contests.status',
      'contests.stage',
      'contests.counts_for_standings',
      'events.division_id',
    ])
    .where('contests.org_id', '=', leagueOrgId)
    .where('events.program_id', '=', programId)
    .execute();
  const contestIds = contests.map((row) => row.id);
  const participants = contestIds.length
    ? await trx
        .selectFrom('contest_participants')
        .select(['id', 'contest_id', 'external_team_id', 'side'])
        .where('org_id', '=', leagueOrgId)
        .where('contest_id', 'in', contestIds)
        .execute()
    : [];
  const results = participants.length
    ? await trx
        .selectFrom('contest_results')
        .select([
          'contest_participant_id',
          sql<number | null>`score::float8`.as('score'),
          'status',
        ])
        .where('org_id', '=', leagueOrgId)
        .where(
          'contest_participant_id',
          'in',
          participants.map((p) => p.id),
        )
        .execute()
    : [];
  const resultByParticipant = new Map(
    results.map((row) => [row.contest_participant_id, row] as const),
  );
  const byContest = new Map<
    string,
    {
      home?: { team: string; score: number | null; forfeit: boolean };
      away?: { team: string; score: number | null; forfeit: boolean };
    }
  >();
  for (const participant of participants) {
    if (!participant.external_team_id) continue;
    const result = resultByParticipant.get(participant.id);
    const slot =
      participant.side === 'home'
        ? ('home' as const)
        : participant.side === 'away'
          ? ('away' as const)
          : null;
    if (!slot) continue;
    const bucket = byContest.get(participant.contest_id) ?? {};
    bucket[slot] = {
      team: participant.external_team_id,
      score: result?.score ?? null,
      forfeit:
        result?.status === 'forfeit_win' || result?.status === 'forfeit_loss',
    };
    byContest.set(participant.contest_id, bucket);
  }
  const standingContests: StandingContest[] = [];
  for (const contest of contests) {
    const pair = byContest.get(contest.id);
    if (!pair?.home || !pair.away) continue;
    const forfeitBy = pair.home.forfeit
      ? ('away' as const)
      : pair.away.forfeit
        ? ('home' as const)
        : undefined;
    if (
      !forfeitBy &&
      (pair.home.score === null || pair.away.score === null)
    )
      continue;
    standingContests.push({
      homeTeamId: pair.home.team,
      awayTeamId: pair.away.team,
      ...(contest.division_id
        ? {
            homeDivisionId: contest.division_id,
            awayDivisionId: contest.division_id,
          }
        : {}),
      stage: contest.stage as StandingContest['stage'],
      finalized:
        contest.status === 'final' || contest.status === 'forfeit',
      countsForStandings: contest.counts_for_standings,
      homeScore: pair.home.score ?? 0,
      awayScore: pair.away.score ?? 0,
      ...(forfeitBy ? { forfeitBy } : {}),
    });
  }
  const divisionViews = divisions.map((division) => ({
    id: division.id,
    name: division.name,
    teamIds: entries
      .filter((entry) => entry.division_id === division.id)
      .map((entry) => entry.external_team_id as string),
  }));
  return { divisions: divisionViews, contests: standingContests };
}

export interface DivisionStandings {
  divisionId: string;
  divisionName: string;
  rows: (StandingRow & { teamName: string })[];
}

async function computeProgramStandings(
  trx: Transaction<DB>,
  leagueOrgId: string,
  programId: string,
): Promise<DivisionStandings[]> {
  const data = await collectProgramContests(trx, leagueOrgId, programId);
  const names = new Map(
    (
      await trx
        .selectFrom('external_teams')
        .select(['id', 'name'])
        .where('org_id', '=', leagueOrgId)
        .execute()
    ).map((row) => [row.id, row.name]),
  );
  const output: DivisionStandings[] = [];
  for (const division of data.divisions) {
    if (!division.teamIds.length) continue;
    const config = await standingsConfig(
      trx,
      leagueOrgId,
      programId,
      division.id,
    );
    const rows = computeStandings(division.teamIds, data.contests, config, {
      divisionId: division.id,
    });
    output.push({
      divisionId: division.id,
      divisionName: division.name,
      rows: rows.map((row) => ({
        ...row,
        teamName: names.get(row.teamId) ?? 'Team',
      })),
    });
  }
  return output;
}

/** League reads standings for its own program. */
export async function leagueStandings(
  database: Kysely<DB>,
  context: OrgContext,
  programId: string,
): Promise<DivisionStandings[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, (trx) =>
    computeProgramStandings(trx, context.orgId, programId),
  );
}

/** Member club reads standings for a program it has an accepted entry in. */
export async function memberStandings(
  context: OrgContext,
  leagueOrgId: string,
  programId: string,
): Promise<DivisionStandings[]> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    await assertActiveRelationship(trx, leagueOrgId, context.orgId);
    const entry = await trx
      .selectFrom('team_entries')
      .select('id')
      .where('org_id', '=', leagueOrgId)
      .where('program_id', '=', programId)
      .where('entrant_org_id', '=', context.orgId)
      .where('status', '=', 'accepted')
      .executeTakeFirst();
    if (!entry)
      throw federationNotFound('The club has no entry in this program');
    const standings = await computeProgramStandings(trx, leagueOrgId, programId);
    const actor = { accountId: context.actor.accountId };
    await appendAuditEvent(trx, { orgId: leagueOrgId, actor }, {
      action: 'federation.cross_org.read',
      entityType: 'program',
      entityId: programId,
      changes: {
        dataset: { tier: 'internal', after: 'standings' },
        requestingOrgId: { tier: 'internal', after: context.orgId },
      },
    });
    await appendAuditEvent(trx, { orgId: context.orgId, actor }, {
      action: 'federation.cross_org.read',
      entityType: 'program',
      entityId: programId,
      changes: {
        dataset: { tier: 'internal', after: 'standings' },
        sourceOrgId: { tier: 'internal', after: leagueOrgId },
      },
    });
    return standings;
  });
}

/** League view: full contest list with participants and results. */
export async function listLeagueContests(
  database: Kysely<DB>,
  context: OrgContext,
  programId: string,
): Promise<
  {
    contestId: string;
    eventId: string;
    startsAt: string;
    divisionId: string | null;
    status: string;
    teams: { side: string; externalTeamId: string; teamName: string; score: number | null }[];
    hostOrgId: string | null;
    hostName: string | null;
  }[]
> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const contests = await trx
      .selectFrom('contests')
      .innerJoin('events', (join) =>
        join
          .onRef('events.org_id', '=', 'contests.org_id')
          .onRef('events.id', '=', 'contests.event_id'),
      )
      .select([
        'contests.id as contest_id',
        'contests.event_id',
        'contests.status',
        'events.starts_at',
        'events.division_id',
      ])
      .where('contests.org_id', '=', context.orgId)
      .where('events.program_id', '=', programId)
      .orderBy('events.starts_at')
      .execute();
    const contestIds = contests.map((row) => row.contest_id);
    const participants = contestIds.length
      ? await trx
          .selectFrom('contest_participants')
          .innerJoin('external_teams', (join) =>
            join
              .onRef('external_teams.org_id', '=', 'contest_participants.org_id')
              .onRef('external_teams.id', '=', 'contest_participants.external_team_id'),
          )
          .select([
            'contest_participants.id as participant_id',
            'contest_participants.contest_id',
            'contest_participants.side',
            'contest_participants.external_team_id',
            'external_teams.name as team_name',
            'external_teams.linked_org_id',
          ])
          .where('contest_participants.org_id', '=', context.orgId)
          .where('contest_participants.contest_id', 'in', contestIds)
          .execute()
      : [];
    const results = participants.length
      ? await trx
          .selectFrom('contest_results')
          .select(['contest_participant_id', 'score'])
          .where('org_id', '=', context.orgId)
          .where(
            'contest_participant_id',
            'in',
            participants.map((p) => p.participant_id),
          )
          .execute()
      : [];
    const resultByParticipant = new Map(
      results.map((row) => [row.contest_participant_id, row.score] as const),
    );
    const links = contestIds.length
      ? await trx
          .selectFrom('federation_event_links')
          .select(['league_event_id', 'club_org_id'])
          .where('league_org_id', '=', context.orgId)
          .where('status', '=', 'active')
          .execute()
      : [];
    const hostByEvent = new Map(
      links.map((row) => [row.league_event_id, row.club_org_id] as const),
    );
    const hostNames = new Map(
      (
        await trx
          .selectFrom('organizations')
          .select(['id', 'name'])
          .where('id', 'in', [...new Set(links.map((row) => row.club_org_id))])
          .execute()
      ).map((row) => [row.id, row.name]),
    );
    return contests.map((contest) => {
      const hostOrgId = hostByEvent.get(contest.event_id) ?? null;
      return {
        contestId: contest.contest_id,
        eventId: contest.event_id,
        startsAt: contest.starts_at.toISOString(),
        divisionId: contest.division_id,
        status: contest.status,
        hostOrgId,
        hostName: hostOrgId ? (hostNames.get(hostOrgId) ?? null) : null,
        teams: participants
          .filter((p) => p.contest_id === contest.contest_id)
          .map((p) => ({
            side: p.side,
            externalTeamId: p.external_team_id ?? '',
            teamName: p.team_name,
            score:
              resultByParticipant.get(p.participant_id) !== undefined
                ? Number(resultByParticipant.get(p.participant_id))
                : null,
          })),
      };
    });
  });
}
