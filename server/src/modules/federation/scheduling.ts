import {
  generateSchedule,
  type DraftEvent,
  type GeneratorDivision,
  type GeneratorInput,
  type GeneratorSpace,
  type GeneratorTeam,
} from '@shared/algorithms/schedule-generator';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';

import { readProgramAvailability } from './availability';
import {
  federationConflict,
  federationNotFound,
  federationUnprocessable,
} from './errors';
import { getFederationAdminDatabase } from './privileged';

export interface ScheduleRunView {
  id: string;
  programId: string;
  status: string;
  seed: number;
  createdAt: string;
  appliedAt: string | null;
  draftCount: number;
  unscheduledCount: number;
  totalPenalty: number;
}

function runView(row: {
  id: string;
  program_id: string;
  status: string;
  seed: string | number | bigint;
  created_at: Date;
  applied_at: Date | null;
  result: unknown;
}): ScheduleRunView {
  const result = row.result as
    | { draftEvents?: unknown[]; unscheduled?: unknown[]; totalPenalty?: number }
    | null;
  return {
    id: row.id,
    programId: row.program_id,
    status: row.status,
    seed: Number(row.seed),
    createdAt: row.created_at.toISOString(),
    appliedAt: row.applied_at?.toISOString() ?? null,
    draftCount: result?.draftEvents?.length ?? 0,
    unscheduledCount: result?.unscheduled?.length ?? 0,
    totalPenalty: result?.totalPenalty ?? 0,
  };
}

function minuteLabel(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * League generates a schedule over its own availability PLUS contributed
 * member-club windows. Runs `shared/src/algorithms/schedule-generator` — the
 * federation module never reimplements scheduling logic. The draft persists as
 * a schedule_generation_runs row for review before apply.
 */
export async function generateLeagueSchedule(
  context: OrgContext,
  input: {
    programId: string;
    seed?: number | undefined;
    rounds: number;
    earliestDate: string;
    latestDate: string;
    gameMinutes: number;
    bufferMinutes: number;
    timeWindows: readonly {
      weekday: number;
      startMinute: number;
      endMinute: number;
    }[];
    maxGamesPerDay?: number | undefined;
    maxGamesPerWeek?: number | undefined;
    minRestDays?: number | undefined;
  },
): Promise<{ run: ScheduleRunView; draftEvents: DraftEvent[] }> {
  const availability = await readProgramAvailability(context, input.programId);
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    const divisions = await trx
      .selectFrom('divisions')
      .select(['id', 'name', 'sort_order'])
      .where('org_id', '=', context.orgId)
      .where('program_id', '=', input.programId)
      .orderBy('sort_order')
      .execute();
    if (!divisions.length) throw federationNotFound('Program not found');
    const entries = await trx
      .selectFrom('team_entries')
      .innerJoin('external_teams', (join) =>
        join
          .onRef('external_teams.org_id', '=', 'team_entries.org_id')
          .onRef('external_teams.id', '=', 'team_entries.external_team_id'),
      )
      .select([
        'team_entries.id',
        'team_entries.division_id',
        'team_entries.external_team_id',
        'team_entries.entrant_org_id',
        'team_entries.seed_hint',
        'external_teams.name as team_name',
      ])
      .where('team_entries.org_id', '=', context.orgId)
      .where('team_entries.program_id', '=', input.programId)
      .where('team_entries.status', '=', 'accepted')
      .where('team_entries.entrant_org_id', 'is not', null)
      .execute();
    if (entries.length < 2)
      throw federationUnprocessable(
        'At least two accepted federation entries are required',
      );
    // A club's first contributed space is its preferred home site.
    const contributions = await trx
      .selectFrom('federation_space_contributions as c')
      .innerJoin('org_relationships as r', 'r.id', 'c.relationship_id')
      .select(['c.space_id', 'c.org_id'])
      .where('r.parent_org_id', '=', context.orgId)
      .where('r.status', '=', 'active')
      .where('c.status', '=', 'offered')
      .execute();
    const homeSpaceByClub = new Map<string, string>();
    for (const row of contributions) {
      if (!homeSpaceByClub.has(row.org_id))
        homeSpaceByClub.set(row.org_id, row.space_id);
    }
    const teams: GeneratorTeam[] = entries.map((entry) => {
      const homeSpaceId = entry.entrant_org_id
        ? homeSpaceByClub.get(entry.entrant_org_id)
        : undefined;
      return {
        id: entry.external_team_id ?? entry.id,
        coachIds: [],
        blackoutDates: [],
        ...(homeSpaceId ? { homeSpaceId } : {}),
        ...(entry.entrant_org_id ? { clubId: entry.entrant_org_id } : {}),
      };
    });
    const teamIdsByDivision = new Map<string, string[]>();
    for (const entry of entries) {
      const id = entry.external_team_id ?? entry.id;
      const list = teamIdsByDivision.get(entry.division_id) ?? [];
      list.push(id);
      teamIdsByDivision.set(entry.division_id, list);
    }
    const weekdaySet = [...new Set(input.timeWindows.map((w) => w.weekday))];
    const generatorDivisions: GeneratorDivision[] = divisions
      .filter((division) => (teamIdsByDivision.get(division.id)?.length ?? 0) >= 2)
      .map((division) => ({
        id: division.id,
        teamIds: teamIdsByDivision.get(division.id) ?? [],
        roundRobin: input.rounds >= 2 ? 'twice' : 'once',
        allowedWeekdays: weekdaySet,
        timeWindows: input.timeWindows.map((window) => ({
          start: minuteLabel(window.startMinute),
          end: minuteLabel(window.endMinute),
        })),
        ageOrder: division.sort_order,
      }));
    if (!generatorDivisions.length)
      throw federationUnprocessable(
        'No division has two accepted federation entries',
      );
    const generatorSpaces: GeneratorSpace[] = availability.spaces.map(
      (space) => ({
        id: space.id,
        facilityId: space.facilityId,
        suitableDivisionIds: generatorDivisions.map((division) => division.id),
        availability: space.availability,
        bookings: space.bookings,
      }),
    );
    if (!generatorSpaces.length)
      throw federationUnprocessable(
        'No league or member-club availability is offered for this program',
      );
    const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
    const generatorInput: GeneratorInput = {
      divisions: generatorDivisions,
      teams,
      spaces: generatorSpaces,
      seasonStartsOn: input.earliestDate,
      seasonEndsOn: input.latestDate,
      timezone: availability.timezone,
      durationMinutes: input.gameMinutes,
      bufferMinutes: input.bufferMinutes,
      maxGamesPerTeamPerDay: input.maxGamesPerDay ?? 1,
      ...(input.maxGamesPerWeek !== undefined
        ? { maxGamesPerTeamPerWeek: input.maxGamesPerWeek }
        : {}),
      ...(input.minRestDays !== undefined
        ? { minRestHours: input.minRestDays * 24 }
        : {}),
      seed,
      timeBudgetSeconds: 45,
    };
    const output = generateSchedule(generatorInput);
    const runId = newId();
    await trx
      .insertInto('schedule_generation_runs')
      .values({
        id: runId,
        org_id: context.orgId,
        program_id: input.programId,
        input: JSON.parse(JSON.stringify(generatorInput)) as never,
        seed,
        status: 'succeeded',
        result: JSON.parse(JSON.stringify(output)) as never,
        created_by: context.actor.accountId,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'federation.schedule.generated',
      entityType: 'schedule_generation_run',
      entityId: runId,
      changes: {
        programId: { tier: 'internal', after: input.programId },
        draftEvents: { tier: 'internal', after: output.draftEvents.length },
        unscheduled: { tier: 'internal', after: output.unscheduled.length },
        penalty: { tier: 'internal', after: output.totalPenalty },
      },
    });
    const row = await trx
      .selectFrom('schedule_generation_runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    return { run: runView(row), draftEvents: output.draftEvents };
  });
}

export async function listScheduleRuns(
  database: Kysely<DB>,
  context: OrgContext,
  programId?: string,
): Promise<ScheduleRunView[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    let query = trx
      .selectFrom('schedule_generation_runs')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .orderBy('created_at', 'desc')
      .limit(50);
    if (programId) query = query.where('program_id', '=', programId);
    const rows = await query.execute();
    return rows.map(runView);
  });
}

export async function getScheduleRun(
  database: Kysely<DB>,
  context: OrgContext,
  runId: string,
): Promise<ScheduleRunView & { draftEvents: DraftEvent[]; unscheduled: unknown[] }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const row = await trx
      .selectFrom('schedule_generation_runs')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!row) throw federationNotFound('Schedule run not found');
    const result = row.result as {
      draftEvents?: DraftEvent[];
      unscheduled?: unknown[];
    } | null;
    return {
      ...runView(row),
      draftEvents: result?.draftEvents ?? [],
      unscheduled: result?.unscheduled ?? [],
    };
  });
}

/**
 * Applies a succeeded run: creates league events + contests + participants, and
 * for games hosted on member-club spaces creates the club-side mirror event,
 * leaf-space bookings (exclusion constraint enforces conflicts) and a
 * federation_event_links row visible to both orgs. One privileged transaction —
 * apply is all-or-nothing across orgs.
 */
export async function applyScheduleRun(
  context: OrgContext,
  runId: string,
): Promise<{ applied: number; hosted: number }> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.org_id', ${context.orgId}, true)`.execute(
      trx,
    );
    await sql`SELECT set_config('app.actor_id', ${context.actor.accountId}, true)`.execute(
      trx,
    );
    const run = await trx
      .selectFrom('schedule_generation_runs')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .forUpdate()
      .executeTakeFirst();
    if (!run) throw federationNotFound('Schedule run not found');
    if (run.status !== 'succeeded')
      throw federationConflict('Run is not in a reviewable state');
    const result = run.result as { draftEvents?: DraftEvent[] } | null;
    const drafts = result?.draftEvents ?? [];
    if (!drafts.length)
      throw federationUnprocessable('Run produced no draft events');
    const program = await trx
      .selectFrom('programs')
      .select('sport_profile_id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', run.program_id)
      .executeTakeFirstOrThrow();
    const org = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', context.orgId)
      .executeTakeFirstOrThrow();
    const timezone = org.timezone;
    const teamNames = new Map(
      (
        await trx
          .selectFrom('external_teams')
          .select(['id', 'name'])
          .where('org_id', '=', context.orgId)
          .execute()
      ).map((row) => [row.id, row.name]),
    );
    // Which org owns each scheduled space (league vs member club)?
    const spaceOwners = new Map<string, { ownerOrgId: string; name: string }>();
    const spaceIds = [...new Set(drafts.map((draft) => draft.spaceId))];
    if (spaceIds.length) {
      const rows = await trx
        .selectFrom('spaces')
        .select(['id', 'org_id', 'name'])
        .where('id', 'in', spaceIds)
        .execute();
      for (const row of rows)
        spaceOwners.set(row.id, { ownerOrgId: row.org_id, name: row.name });
    }
    const relationshipByClub = new Map<string, string>();
    const clubRelationships = await trx
      .selectFrom('org_relationships')
      .select(['id', 'child_org_id'])
      .where('parent_org_id', '=', context.orgId)
      .where('status', '=', 'active')
      .execute();
    for (const row of clubRelationships)
      relationshipByClub.set(row.child_org_id, row.id);

    let applied = 0;
    let hosted = 0;
    const clubAuditCounts = new Map<string, number>();
    for (const draft of drafts) {
      const owner = spaceOwners.get(draft.spaceId);
      if (!owner)
        throw federationUnprocessable(
          `Space ${draft.spaceId} no longer exists`,
        );
      const hostedByClub = owner.ownerOrgId !== context.orgId;
      const home = teamNames.get(draft.homeTeamId) ?? 'Home';
      const away = teamNames.get(draft.awayTeamId) ?? 'Away';
      const title = `${away} at ${home}`;
      const leagueEventId = newId();
      await trx
        .insertInto('events')
        .values({
          id: leagueEventId,
          org_id: context.orgId,
          program_id: run.program_id,
          division_id: draft.divisionId,
          kind: 'game',
          title,
          starts_at: new Date(draft.startsAt),
          ends_at: new Date(draft.endsAt),
          timezone,
          space_id: hostedByClub ? null : draft.spaceId,
          location_text: hostedByClub ? owner.name : null,
          status: 'scheduled',
          published: false,
          generation_run_id: runId,
        })
        .execute();
      const contestId = newId();
      await trx
        .insertInto('contests')
        .values({
          id: contestId,
          org_id: context.orgId,
          event_id: leagueEventId,
          sport_profile_id: program.sport_profile_id,
          profile_version: 1,
          format: 'head_to_head_score',
          stage: 'regular',
          counts_for_standings: true,
          status: 'scheduled',
        })
        .execute();
      for (const [teamId, side] of [
        [draft.homeTeamId, 'home'],
        [draft.awayTeamId, 'away'],
      ] as const) {
        await trx
          .insertInto('contest_participants')
          .values({
            id: newId(),
            org_id: context.orgId,
            contest_id: contestId,
            team_season_id: null,
            external_team_id: teamId,
            person_id: null,
            side,
          })
          .execute();
      }
      applied += 1;
      if (!hostedByClub) continue;
      const relationshipId = relationshipByClub.get(owner.ownerOrgId);
      if (!relationshipId)
        throw federationUnprocessable(
          'A host club relationship is no longer active',
        );
      // Mirror event + leaf bookings in the club org.
      const clubEventId = newId();
      await trx
        .insertInto('events')
        .values({
          id: clubEventId,
          org_id: owner.ownerOrgId,
          kind: 'game',
          title: `${title} (league game)`,
          starts_at: new Date(draft.startsAt),
          ends_at: new Date(draft.endsAt),
          timezone,
          space_id: draft.spaceId,
          status: 'scheduled',
          published: true,
        })
        .execute();
      const leaves = await sql<{ id: string }>`
        WITH RECURSIVE descendants AS (
          SELECT id FROM spaces WHERE org_id = ${owner.ownerOrgId}::uuid AND id = ${draft.spaceId}::uuid
          UNION ALL
          SELECT child.id FROM spaces child
          JOIN descendants parent ON child.parent_space_id = parent.id
          WHERE child.org_id = ${owner.ownerOrgId}::uuid
        )
        SELECT d.id FROM descendants d
        WHERE NOT EXISTS (
          SELECT 1 FROM spaces child WHERE child.org_id = ${owner.ownerOrgId}::uuid AND child.parent_space_id = d.id
        )
      `.execute(trx);
      const bookingGroupId = newId();
      for (const leaf of leaves.rows) {
        await trx
          .insertInto('space_bookings')
          .values({
            id: newId(),
            org_id: owner.ownerOrgId,
            booking_group_id: bookingGroupId,
            leaf_space_id: leaf.id,
            during: sql`tstzrange(${draft.startsAt}::timestamptz, ${draft.blockedUntil}::timestamptz, '[)')`,
            event_id: clubEventId,
            allocation_id: null,
          })
          .execute();
      }
      await trx
        .insertInto('federation_event_links')
        .values({
          id: newId(),
          league_org_id: context.orgId,
          club_org_id: owner.ownerOrgId,
          relationship_id: relationshipId,
          league_event_id: leagueEventId,
          club_event_id: clubEventId,
          booking_group_id: bookingGroupId,
          leaf_space_ids: leaves.rows.map((leaf) => leaf.id),
          during: sql`tstzrange(${draft.startsAt}::timestamptz, ${draft.blockedUntil}::timestamptz, '[)')`,
          status: 'active',
        })
        .execute();
      hosted += 1;
      clubAuditCounts.set(
        owner.ownerOrgId,
        (clubAuditCounts.get(owner.ownerOrgId) ?? 0) + 1,
      );
    }
    await trx
      .updateTable('schedule_generation_runs')
      .set({
        status: 'applied',
        applied_at: new Date(),
        version: run.version + 1,
      })
      .where('id', '=', runId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'federation.schedule.applied',
      entityType: 'schedule_generation_run',
      entityId: runId,
      changes: {
        events: { tier: 'internal', after: applied },
        hostedAtMemberClubs: { tier: 'internal', after: hosted },
      },
    });
    for (const [clubId, count] of clubAuditCounts) {
      await appendAuditEvent(
        trx,
        { orgId: clubId, actor: context.actor },
        {
          action: 'federation.schedule.games_hosted',
          entityType: 'schedule_generation_run',
          entityId: runId,
          changes: {
            leagueOrgId: { tier: 'internal', after: context.orgId },
            games: { tier: 'internal', after: count },
          },
        },
      );
    }
    return { applied, hosted };
  });
}

/** Flips league events of an applied run to published. */
export async function publishScheduleRun(
  database: Kysely<DB>,
  context: OrgContext,
  runId: string,
): Promise<{ published: number }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const run = await trx
      .selectFrom('schedule_generation_runs')
      .select(['id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .forUpdate()
      .executeTakeFirst();
    if (!run) throw federationNotFound('Schedule run not found');
    if (run.status !== 'applied')
      throw federationConflict('Run has not been applied');
    const result = await trx
      .updateTable('events')
      .set({ published: true })
      .where('org_id', '=', context.orgId)
      .where('generation_run_id', '=', runId)
      .where('published', '=', false)
      .executeTakeFirst();
    const published = Number(result.numUpdatedRows);
    await appendAuditEvent(trx, context, {
      action: 'federation.schedule.published',
      entityType: 'schedule_generation_run',
      entityId: runId,
      changes: { events: { tier: 'internal', after: published } },
    });
    return { published };
  });
}

export async function discardScheduleRun(
  database: Kysely<DB>,
  context: OrgContext,
  runId: string,
): Promise<{ id: string }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const run = await trx
      .selectFrom('schedule_generation_runs')
      .select(['id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .forUpdate()
      .executeTakeFirst();
    if (!run) throw federationNotFound('Schedule run not found');
    if (!['succeeded', 'failed'].includes(run.status))
      throw federationConflict('Only unapplied runs can be discarded');
    await trx
      .updateTable('schedule_generation_runs')
      .set({ status: 'discarded' })
      .where('id', '=', runId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'federation.schedule.discarded',
      entityType: 'schedule_generation_run',
      entityId: runId,
      changes: {},
    });
    return { id: runId };
  });
}

/**
 * Club view: league games hosted on its spaces (event links + the league
 * event's title/time). Privileged read — audited in both orgs.
 */
export async function listHostedGames(
  context: OrgContext,
): Promise<
  {
    linkId: string;
    leagueOrgId: string;
    leagueOrgName: string;
    leagueEventId: string;
    clubEventId: string;
    title: string;
    startsAt: string;
    endsAt: string;
    status: string;
  }[]
> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    const leagueIds = await trx
      .selectFrom('org_relationships')
      .select('parent_org_id')
      .where('child_org_id', '=', context.orgId)
      .where('status', '=', 'active')
      .execute();
    if (!leagueIds.length) return [];
    const rows = await trx
      .selectFrom('federation_event_links as l')
      .innerJoin('events as e', 'e.id', 'l.league_event_id')
      .select([
        'l.id as link_id',
        'l.league_org_id',
        'l.league_event_id',
        'l.club_event_id',
        'l.status as link_status',
        'e.title',
        'e.starts_at',
        'e.ends_at',
        'e.status as event_status',
      ])
      .where('l.club_org_id', '=', context.orgId)
      .where(
        'l.league_org_id',
        'in',
        leagueIds.map((row) => row.parent_org_id),
      )
      .orderBy('e.starts_at')
      .limit(500)
      .execute();
    const orgNames = await trx
      .selectFrom('organizations')
      .select(['id', 'name'])
      .where(
        'id',
        'in',
        leagueIds.map((row) => row.parent_org_id),
      )
      .execute();
    const nameById = new Map(orgNames.map((row) => [row.id, row.name]));
    const actor = { accountId: context.actor.accountId };
    for (const leagueId of leagueIds.map((row) => row.parent_org_id)) {
      await appendAuditEvent(trx, { orgId: leagueId, actor }, {
        action: 'federation.cross_org.read',
        entityType: 'federation_event_link',
        entityId: context.orgId,
        changes: {
          dataset: { tier: 'internal', after: 'hosted_games' },
          requestingOrgId: { tier: 'internal', after: context.orgId },
        },
      });
    }
    await appendAuditEvent(trx, context, {
      action: 'federation.hosted_games.read',
      entityType: 'federation_event_link',
      entityId: context.orgId,
      changes: { count: { tier: 'internal', after: rows.length } },
    });
    return rows.map((row) => ({
      linkId: row.link_id,
      leagueOrgId: row.league_org_id,
      leagueOrgName: nameById.get(row.league_org_id) ?? 'League',
      leagueEventId: row.league_event_id,
      clubEventId: row.club_event_id,
      title: row.title,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      status: row.event_status,
    }));
  });
}
