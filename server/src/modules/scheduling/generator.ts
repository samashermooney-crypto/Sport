import { generateSchedule } from '@shared/algorithms/schedule-generator';
import type {
  GeneratorInput,
  GeneratorOutput,
} from '@shared/algorithms/schedule-generator';
import { newId } from '@shared/ids';
import { expand } from '@shared/recurrence';
import { sql } from 'kysely';
import { PgBoss } from 'pg-boss';

import { getDatabase } from '../../db/kysely';
import type { Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { VersionConflictError } from '../../lib/version-check';
import { appendAuditEvent } from '../audit/service';

import { assertSchedulePermission } from './access';
import {
  eventRecipients,
  getConflicts,
  insertSpaceBooking,
  queueChangeBatch,
  resolveTimezoneAndBuffer,
  SchedulingRuleError,
} from './events';
import type {
  EventCreateWithOverrideInput,
  GeneratorConstraints,
} from './schema';

export const scheduleGenerationJob = 'scheduling.generate';
export const scheduleSeriesHorizonJob = 'scheduling.extend-series';
export const scheduleBatchEmitJob = 'scheduling.emit-change-batches';

let boss: PgBoss | undefined;
let bossStarting: Promise<PgBoss> | undefined;

async function queue(): Promise<PgBoss> {
  if (boss) return boss;
  if (bossStarting) return bossStarting;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error('DATABASE_URL is required to queue schedule jobs');
  bossStarting = (async () => {
    const client = new PgBoss({
      connectionString,
      migrate: false,
      createSchema: false,
    });
    await client.start();
    boss = client;
    return client;
  })();
  try {
    return await bossStarting;
  } finally {
    bossStarting = undefined;
  }
}

export async function sendSchedulingJob(
  name: string,
  data: unknown,
): Promise<string | null> {
  return (await queue()).send(name, data as Record<string, unknown>);
}

function minutesBetween(start: string, end: string): number {
  const startMs = new Date(`2000-01-01T${start}Z`).getTime();
  const endMs = new Date(`2000-01-01T${end}Z`).getTime();
  return (endMs - startMs) / 60_000;
}

function getBufferAndDuration(profile: unknown): {
  bufferMinutes: number;
  durationMinutes: number;
  spaceKinds: string[];
} {
  const value = profile as {
    defaultDurations?: { contestMinutes?: unknown; bufferMinutes?: unknown };
    spaceKinds?: unknown;
  };
  const duration = value.defaultDurations?.contestMinutes;
  const buffer = value.defaultDurations?.bufferMinutes;
  return {
    durationMinutes:
      typeof duration === 'number' && duration > 0 ? duration : 60,
    bufferMinutes: typeof buffer === 'number' && buffer >= 0 ? buffer : 0,
    spaceKinds: Array.isArray(value.spaceKinds)
      ? value.spaceKinds.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
  };
}

async function buildInput(
  trx: OrgTransaction,
  orgId: string,
  programId: string,
  constraints: GeneratorConstraints,
): Promise<GeneratorInput> {
  const program = await trx
    .selectFrom('programs')
    .innerJoin('sport_profiles', (join) =>
      join
        .onRef('sport_profiles.org_id', '=', 'programs.org_id')
        .onRef('sport_profiles.id', '=', 'programs.sport_profile_id'),
    )
    .select([
      'programs.id',
      'programs.starts_on',
      'programs.ends_on',
      'sport_profiles.id as sport_profile_id',
      'sport_profiles.profile',
    ])
    .where('programs.org_id', '=', orgId)
    .where('programs.id', '=', programId)
    .executeTakeFirst();
  if (!program)
    throw new SchedulingRuleError('Program not found.', 404, 'NOT_FOUND');
  const programStarts = program.starts_on.toISOString().slice(0, 10);
  const programEnds = program.ends_on.toISOString().slice(0, 10);
  if (
    constraints.seasonStartsOn < programStarts ||
    constraints.seasonEndsOn > programEnds ||
    constraints.seasonStartsOn > constraints.seasonEndsOn
  )
    throw new SchedulingRuleError(
      'Generator dates must fit within the program season.',
    );
  const org = await trx
    .selectFrom('organizations')
    .select('timezone')
    .where('id', '=', orgId)
    .executeTakeFirstOrThrow();
  const { durationMinutes, bufferMinutes, spaceKinds } = getBufferAndDuration(
    program.profile,
  );
  const divisions = await trx
    .selectFrom('divisions')
    .select(['id', 'name', 'program_id'])
    .where('org_id', '=', orgId)
    .where('program_id', '=', programId)
    .execute();
  const configured = new Map(
    constraints.divisions.map((division) => [division.divisionId, division]),
  );
  if (
    configured.size !== constraints.divisions.length ||
    constraints.divisions.some(
      (division) => !divisions.some((item) => item.id === division.divisionId),
    )
  )
    throw new SchedulingRuleError(
      'Every generator division must belong to the selected program.',
    );
  const teamSeasons = await trx
    .selectFrom('team_seasons')
    .innerJoin('teams', (join) =>
      join
        .onRef('teams.org_id', '=', 'team_seasons.org_id')
        .onRef('teams.id', '=', 'team_seasons.team_id'),
    )
    .select([
      'team_seasons.id',
      'team_seasons.division_id',
      'team_seasons.home_facility_id',
      'teams.id as team_id',
    ])
    .where('team_seasons.org_id', '=', orgId)
    .where('team_seasons.program_id', '=', programId)
    .where('team_seasons.status', '=', 'active')
    .where('team_seasons.division_id', 'in', [...configured.keys()])
    .execute();
  const byDivision = new Map<string, typeof teamSeasons>();
  for (const team of teamSeasons) {
    if (!team.division_id) continue;
    const current = byDivision.get(team.division_id) ?? [];
    current.push(team);
    byDivision.set(team.division_id, current);
  }
  const teamIds = teamSeasons.map((team) => team.id);
  const staffRows = teamIds.length
    ? await trx
        .selectFrom('team_staff')
        .select(['team_season_id', 'person_id'])
        .where('org_id', '=', orgId)
        .where('team_season_id', 'in', teamIds)
        .where('status', '=', 'active')
        .where('role', 'in', [
          'head_coach',
          'assistant_coach',
          'team_manager',
          'trainer',
        ])
        .execute()
    : [];
  const staffPersonIds = [...new Set(staffRows.map((row) => row.person_id))];
  const accountLinks = staffPersonIds.length
    ? await trx
        .selectFrom('person_account_links')
        .select(['person_id', 'account_id'])
        .where('org_id', '=', orgId)
        .where('person_id', 'in', staffPersonIds)
        .where('relationship', '=', 'self')
        .where('revoked_at', 'is', null)
        .execute()
    : [];
  const coachIds = new Map<string, string[]>();
  for (const row of staffRows) {
    const ids = coachIds.get(row.team_season_id) ?? [];
    ids.push(
      ...accountLinks
        .filter((link) => link.person_id === row.person_id)
        .map((link) => link.account_id),
    );
    coachIds.set(row.team_season_id, ids);
  }
  const rosterRows = teamIds.length
    ? await trx
        .selectFrom('roster_entries')
        .select(['team_season_id', 'person_id'])
        .where('org_id', '=', orgId)
        .where('team_season_id', 'in', teamIds)
        .where('status', 'in', ['active', 'injured', 'suspended'])
        .execute()
    : [];
  const rosterPeople = [...new Set(rosterRows.map((row) => row.person_id))];
  const householdRows = rosterPeople.length
    ? await trx
        .selectFrom('registrations')
        .select(['person_id', 'household_id'])
        .where('org_id', '=', orgId)
        .where('program_id', '=', programId)
        .where('person_id', 'in', rosterPeople)
        .where('status', '=', 'confirmed')
        .execute()
    : [];
  const householdIds = new Map<string, string[]>();
  for (const roster of rosterRows) {
    const ids = householdIds.get(roster.team_season_id) ?? [];
    ids.push(
      ...householdRows
        .filter((row) => row.person_id === roster.person_id)
        .map((row) => row.household_id),
    );
    householdIds.set(roster.team_season_id, ids);
  }
  const divisionsInput = constraints.divisions.map((setting) => {
    const teams = byDivision.get(setting.divisionId) ?? [];
    if (teams.length < 2)
      throw new SchedulingRuleError(
        `Division ${setting.divisionId} needs at least two active teams.`,
      );
    return {
      id: setting.divisionId,
      teamIds: teams.map((team) => team.id),
      allowedWeekdays: setting.allowedWeekdays,
      timeWindows: setting.timeWindows,
      ...(setting.gamesPerTeam === undefined
        ? {}
        : { gamesPerTeam: setting.gamesPerTeam }),
      ...(setting.roundRobin === undefined
        ? {}
        : { roundRobin: setting.roundRobin }),
      ...(setting.preferredStartMinutes === undefined
        ? {}
        : { preferredStartMinutes: setting.preferredStartMinutes }),
      ...(setting.ageOrder === undefined ? {} : { ageOrder: setting.ageOrder }),
    };
  });
  const teamsInputBase = teamSeasons.map((team) => ({
    id: team.id,
    coachIds: [...new Set(coachIds.get(team.id) ?? [])],
    blackoutDates: [] as string[],
    householdIds: [...new Set(householdIds.get(team.id) ?? [])],
  }));

  const spaces = await trx
    .selectFrom('spaces')
    .innerJoin('facilities', (join) =>
      join
        .onRef('facilities.org_id', '=', 'spaces.org_id')
        .onRef('facilities.id', '=', 'spaces.facility_id'),
    )
    .select([
      'spaces.id',
      'spaces.facility_id',
      'spaces.parent_space_id',
      'spaces.kind',
      'spaces.suitability',
      'spaces.archived_at',
      'facilities.timezone',
    ])
    .where('spaces.org_id', '=', orgId)
    .where('spaces.archived_at', 'is', null)
    .where('facilities.archived_at', 'is', null)
    .execute();
  const childIds = new Set(
    spaces.flatMap((space) =>
      space.parent_space_id ? [space.parent_space_id] : [],
    ),
  );
  const leaves = spaces.filter(
    (space) =>
      !childIds.has(space.id) &&
      (spaceKinds.length === 0 || spaceKinds.includes(space.kind)),
  );
  const teamBlackouts = teamIds.length
    ? await trx
        .selectFrom('schedule_blackout_requests')
        .select(['team_season_id', 'starts_on', 'ends_on'])
        .where('org_id', '=', orgId)
        .where('team_season_id', 'in', teamIds)
        .where('status', '=', 'approved')
        .where(
          'starts_on',
          '<=',
          new Date(`${constraints.seasonEndsOn}T23:59:59.999Z`),
        )
        .where(
          'ends_on',
          '>=',
          new Date(`${constraints.seasonStartsOn}T00:00:00.000Z`),
        )
        .execute()
    : [];
  const blackoutsByTeam = new Map<string, Set<string>>();
  for (const blackout of teamBlackouts) {
    const dates =
      blackoutsByTeam.get(blackout.team_season_id) ?? new Set<string>();
    const cursor = new Date(
      `${blackout.starts_on.toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    const end = new Date(
      `${blackout.ends_on.toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    while (cursor <= end) {
      const date = cursor.toISOString().slice(0, 10);
      if (
        date >= constraints.seasonStartsOn &&
        date <= constraints.seasonEndsOn
      )
        dates.add(date);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    blackoutsByTeam.set(blackout.team_season_id, dates);
  }
  const homeSpaceByTeam = new Map<string, string>();
  for (const team of teamSeasons) {
    if (!team.home_facility_id) continue;
    const homeLeaf = leaves.find(
      (space) => space.facility_id === team.home_facility_id,
    );
    if (homeLeaf) homeSpaceByTeam.set(team.id, homeLeaf.id);
  }
  const teamsInput = teamsInputBase.map((team) => ({
    ...team,
    blackoutDates: [...(blackoutsByTeam.get(team.id) ?? [])].sort(),
    ...(homeSpaceByTeam.has(team.id)
      ? { homeSpaceId: homeSpaceByTeam.get(team.id) as string }
      : {}),
  }));
  const spaceIds = spaces.map((space) => space.id);
  const availability = spaceIds.length
    ? await trx
        .selectFrom('space_availability')
        .select([
          'space_id',
          'recurrence',
          'starts_on',
          'ends_on',
          'start_time',
          'end_time',
        ])
        .where('org_id', '=', orgId)
        .where('space_id', 'in', spaceIds)
        .execute()
    : [];
  const blackouts = spaceIds.length
    ? await trx
        .selectFrom('space_blackouts')
        .select(['space_id', 'facility_id', 'starts_at', 'ends_at'])
        .where('org_id', '=', orgId)
        .where(
          'starts_at',
          '<',
          new Date(`${constraints.seasonEndsOn}T23:59:59.999Z`),
        )
        .where(
          'ends_at',
          '>',
          new Date(`${constraints.seasonStartsOn}T00:00:00.000Z`),
        )
        .execute()
    : [];
  const closureRows = await trx
    .selectFrom('closures')
    .select(['scope_type', 'scope_id', 'starts_at', 'ends_at'])
    .where('org_id', '=', orgId)
    .where(
      'starts_at',
      '<',
      new Date(`${constraints.seasonEndsOn}T23:59:59.999Z`),
    )
    .where(
      'ends_at',
      '>',
      new Date(`${constraints.seasonStartsOn}T00:00:00.000Z`),
    )
    .execute();
  const bookings = spaceIds.length
    ? await sql<{ leaf_space_id: string; starts_at: string; ends_at: string }>`
        SELECT leaf_space_id, lower(during)::text AS starts_at, upper(during)::text AS ends_at
        FROM space_bookings
        WHERE org_id = ${orgId}
          AND leaf_space_id = ANY(${sql.val(spaceIds)}::uuid[])
          AND during && tstzrange(${`${constraints.seasonStartsOn}T00:00:00.000Z`}::timestamptz, ${`${constraints.seasonEndsOn}T23:59:59.999Z`}::timestamptz, '[)')
      `.execute(trx)
    : {
        rows: [] as {
          leaf_space_id: string;
          starts_at: string;
          ends_at: string;
        }[],
      };
  const spaceInputs: Array<GeneratorInput['spaces'][number]> = [];
  for (const leaf of leaves) {
    const ancestorIds = new Set<string>([leaf.id]);
    let parentId = leaf.parent_space_id;
    while (parentId) {
      ancestorIds.add(parentId);
      parentId =
        spaces.find((space) => space.id === parentId)?.parent_space_id ?? null;
    }
    const spaceAvailability = availability.filter((window) =>
      ancestorIds.has(window.space_id),
    );
    const availabilityWindows = spaceAvailability.flatMap((window) => {
      const timezone =
        spaces.find((space) => space.id === window.space_id)?.timezone ??
        org.timezone;
      try {
        const duration = minutesBetween(window.start_time, window.end_time);
        return expand(
          {
            recurrence: window.recurrence as never,
            startTime: window.start_time,
            durationMinutes: duration,
            timezone,
          },
          constraints.seasonStartsOn,
          constraints.seasonEndsOn,
        ).map((occurrence) => ({
          startsAt: occurrence.startsAt,
          endsAt: occurrence.endsAt,
        }));
      } catch {
        return [];
      }
    });
    const facilityBlackouts = blackouts.filter(
      (item) =>
        (item.space_id && ancestorIds.has(item.space_id)) ||
        item.facility_id === leaf.facility_id,
    );
    const allBlackouts = [
      ...facilityBlackouts,
      ...closureRows.filter(
        (item) =>
          item.scope_type === 'org' ||
          (item.scope_type === 'facility' &&
            item.scope_id === leaf.facility_id) ||
          (item.scope_type === 'space' && ancestorIds.has(item.scope_id ?? '')),
      ),
    ].map((item) => ({
      startsAt: item.starts_at.toISOString(),
      endsAt: item.ends_at.toISOString(),
    }));
    const profile = leaf.suitability as { sportProfileIds?: unknown };
    const sportSuitable =
      !Array.isArray(profile.sportProfileIds) ||
      profile.sportProfileIds.length === 0 ||
      profile.sportProfileIds.includes(program.sport_profile_id);
    const suitable = sportSuitable
      ? constraints.divisions.map((division) => division.divisionId)
      : [];
    spaceInputs.push({
      id: leaf.id,
      facilityId: leaf.facility_id,
      suitableDivisionIds: suitable,
      conflictSpaceIds: [...ancestorIds],
      availability: availabilityWindows,
      blackouts: allBlackouts,
      bookings: bookings.rows
        .filter((item) => item.leaf_space_id === leaf.id)
        .map((item) => ({ startsAt: item.starts_at, endsAt: item.ends_at })),
    });
  }
  if (!spaceInputs.length)
    throw new SchedulingRuleError(
      'No active spaces are suitable for this sport.',
    );
  return {
    divisions: divisionsInput,
    teams: teamsInput,
    spaces: spaceInputs,
    seasonStartsOn: constraints.seasonStartsOn,
    seasonEndsOn: constraints.seasonEndsOn,
    timezone: org.timezone,
    durationMinutes,
    bufferMinutes,
    maxGamesPerTeamPerDay: constraints.maxGamesPerTeamPerDay,
    ...(constraints.maxGamesPerTeamPerWeek === undefined
      ? {}
      : { maxGamesPerTeamPerWeek: constraints.maxGamesPerTeamPerWeek }),
    minRestHours: constraints.minRestHours,
    seed: constraints.seed,
    timeBudgetSeconds: constraints.timeBudgetSeconds,
  };
}

export async function createGenerationRun(
  context: OrgContext,
  programId: string,
  constraints: GeneratorConstraints,
) {
  const run = await withOrg(context, async (trx) => {
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId,
    });
    const input = await buildInput(trx, context.orgId, programId, constraints);
    const id = newId();
    await trx
      .insertInto('schedule_generation_runs')
      .values({
        id,
        org_id: context.orgId,
        program_id: programId,
        input: input as unknown as Json,
        seed: constraints.seed,
        status: 'queued',
        progress: 0,
        progress_message: 'Waiting for a schedule worker',
        created_by: context.actor.accountId,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'schedule.generator.create',
      entityType: 'schedule_generation_run',
      entityId: id,
    });
    return id;
  });
  try {
    await (
      await queue()
    ).send(scheduleGenerationJob, { orgId: context.orgId, runId: run });
  } catch {
    await withOrg(context, async (trx) => {
      await trx
        .updateTable('schedule_generation_runs')
        .set({
          status: 'failed',
          progress_message: 'Schedule worker could not be reached',
          error_code: 'JOB_QUEUE_UNAVAILABLE',
          version: sql`version + 1`,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', run)
        .execute();
    });
    throw new SchedulingRuleError(
      'The schedule generator is unavailable right now.',
      503,
      'DEPENDENCY_UNAVAILABLE',
    );
  }
  return run;
}

export async function runScheduleGeneration(data: unknown): Promise<unknown> {
  const job = data as { orgId?: unknown; runId?: unknown };
  if (typeof job.orgId !== 'string' || typeof job.runId !== 'string')
    throw new RangeError('Invalid schedule generation job');
  const orgId = job.orgId;
  const runId = job.runId;
  const context = await withOrg(
    { orgId, actor: { accountId: newId() } },
    async (trx) => {
      const current = await trx
        .selectFrom('schedule_generation_runs')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!current || current.status !== 'queued') return null;
      await trx
        .updateTable('schedule_generation_runs')
        .set({
          status: 'running',
          progress: 10,
          progress_message: 'Loading teams and available spaces',
          version: current.version + 1,
        })
        .where('org_id', '=', orgId)
        .where('id', '=', runId)
        .execute();
      await sql`select pg_notify('schedule_progress', ${JSON.stringify({ orgId, runId, status: 'running', progress: 10 })})`.execute(
        trx,
      );
      return {
        createdBy: current.created_by,
        programId: current.program_id,
        input: current.input as unknown as GeneratorInput,
        version: current.version + 1,
      };
    },
  );
  if (!context) return { skipped: true };
  const orgContext: OrgContext = {
    orgId,
    actor: { accountId: context.createdBy },
  };
  const result = generateSchedule(context.input);
  await withOrg(orgContext, async (trx) => {
    await trx
      .updateTable('schedule_generation_runs')
      .set({
        status: 'succeeded',
        result: result as unknown as Json,
        progress: 100,
        progress_message: 'Schedule draft is ready',
        error_code: null,
        version: context.version + 1,
      })
      .where('org_id', '=', orgId)
      .where('id', '=', runId)
      .execute();
    await sql`select pg_notify('schedule_progress', ${JSON.stringify({ orgId, runId, status: 'succeeded', progress: 100 })})`.execute(
      trx,
    );
  });
  return { runId, unscheduled: result.unscheduled.length };
}

export async function getGenerationRun(context: OrgContext, runId: string) {
  return withOrg(context, async (trx) => {
    const run = await trx
      .selectFrom('schedule_generation_runs')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run)
      throw new SchedulingRuleError(
        'Schedule run not found.',
        404,
        'NOT_FOUND',
      );
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId: run.program_id,
    });
    return run;
  });
}

export async function applyGenerationRun(
  context: OrgContext,
  runId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    const run = await trx
      .selectFrom('schedule_generation_runs')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run)
      throw new SchedulingRuleError(
        'Schedule run not found.',
        404,
        'NOT_FOUND',
      );
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId: run.program_id,
    });
    if (run.version !== expectedVersion) throw new VersionConflictError(run);
    if (run.status !== 'succeeded')
      throw new SchedulingRuleError(
        'Only a completed generator run can be applied.',
        409,
        'CONFLICT',
      );
    const input = run.input as unknown as GeneratorInput;
    const result = run.result as unknown as GeneratorOutput;
    const ids: string[] = [];
    for (const draft of result.draftEvents) {
      const id = newId();
      const proposed = {
        id: draft.homeTeamId,
        awayId: draft.awayTeamId,
      };
      const division = input.divisions.find(
        (item) => item.id === draft.divisionId,
      );
      if (!division)
        throw new SchedulingRuleError(
          'Generator result references a missing division.',
          409,
          'SCHEDULE_CONFLICT',
        );
      const candidate = {
        kind: 'game',
        title: 'Game',
        startsAt: draft.startsAt,
        endsAt: draft.endsAt,
        programId: run.program_id,
        divisionId: draft.divisionId,
        spaceId: draft.spaceId,
        locationText: null,
        notesHtml: null,
        arrivalMinutesBefore: 0,
        participants: [
          { type: 'team' as const, id: proposed.id, side: 'home' as const },
          { type: 'team' as const, id: proposed.awayId, side: 'away' as const },
        ],
        published: false,
      } as EventCreateWithOverrideInput;
      const conflicts = await getConflicts(trx, context, candidate);
      if (conflicts.length)
        throw new SchedulingRuleError(
          'The draft contains a conflict and could not be applied.',
          409,
          'SCHEDULE_CONFLICT',
          { conflicts },
        );
      const { timezone, bufferMinutes } = await resolveTimezoneAndBuffer(
        trx,
        context.orgId,
        draft.spaceId,
        run.program_id,
      );
      const event = await trx
        .insertInto('events')
        .values({
          id,
          org_id: context.orgId,
          program_id: run.program_id,
          division_id: draft.divisionId,
          kind: 'game',
          title: 'Game',
          starts_at: new Date(draft.startsAt),
          ends_at: new Date(draft.endsAt),
          timezone,
          space_id: draft.spaceId,
          generation_run_id: runId,
          published: false,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('event_participants')
        .values([
          {
            id: newId(),
            org_id: context.orgId,
            event_id: id,
            team_season_id: proposed.id,
            side: 'home',
          },
          {
            id: newId(),
            org_id: context.orgId,
            event_id: id,
            team_season_id: proposed.awayId,
            side: 'away',
          },
        ])
        .execute();
      await insertSpaceBooking(
        trx,
        context.orgId,
        draft.spaceId,
        event.starts_at,
        event.ends_at,
        bufferMinutes,
        id,
      );
      ids.push(id);
    }
    const updated = await trx
      .updateTable('schedule_generation_runs')
      .set({
        status: 'applied',
        applied_at: new Date(),
        version: run.version + 1,
        progress_message: `${String(ids.length)} events applied`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(run);
    await appendAuditEvent(trx, context, {
      action: 'schedule.generator.apply',
      entityType: 'schedule_generation_run',
      entityId: runId,
      changes: { eventCount: { tier: 'internal', after: ids.length } },
    });
    return { runId, eventIds: ids, unscheduled: result.unscheduled };
  });
}

export async function discardGenerationRun(
  context: OrgContext,
  runId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    const run = await trx
      .selectFrom('schedule_generation_runs')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run)
      throw new SchedulingRuleError(
        'Schedule run not found.',
        404,
        'NOT_FOUND',
      );
    await assertSchedulePermission(trx, context, 'schedule.manage', {
      programId: run.program_id,
    });
    if (run.version !== expectedVersion) throw new VersionConflictError(run);
    if (!['queued', 'running', 'succeeded'].includes(run.status))
      throw new SchedulingRuleError(
        'This generator run cannot be discarded.',
        409,
        'CONFLICT',
      );
    const updated = await trx
      .updateTable('schedule_generation_runs')
      .set({
        status: 'discarded',
        progress_message: 'Draft discarded',
        version: run.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', runId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new VersionConflictError(run);
    await appendAuditEvent(trx, context, {
      action: 'schedule.generator.discard',
      entityType: 'schedule_generation_run',
      entityId: runId,
    });
    return updated;
  });
}

export async function extendRecurringSeries(): Promise<{
  extended: number;
  skippedConflicts: number;
}> {
  const database = getDatabase();
  const orgs = await database
    .selectFrom('organizations')
    .select('id')
    .execute();
  let extended = 0;
  let skippedConflicts = 0;
  for (const org of orgs) {
    const actor = { orgId: org.id, actor: { accountId: newId() } };
    extended += await withOrg(actor, async (trx) => {
      const seriesRows = await trx
        .selectFrom('event_series')
        .selectAll()
        .where('org_id', '=', org.id)
        .where('active', '=', true)
        .execute();
      let count = 0;
      for (const series of seriesRows) {
        const lastEvent = await trx
          .selectFrom('events')
          .select('starts_at')
          .where('org_id', '=', org.id)
          .where('series_id', '=', series.id)
          .orderBy('starts_at', 'desc')
          .executeTakeFirst();
        const startDate = lastEvent
          ? new Intl.DateTimeFormat('en-CA', {
              timeZone: series.timezone,
            }).format(lastEvent.starts_at)
          : new Date().toISOString().slice(0, 10);
        const endDate = new Date(Date.now() + 548 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const occurrenceRows = expand(
          {
            recurrence: series.recurrence as never,
            startTime: series.start_time,
            durationMinutes: series.duration_minutes,
            timezone: series.timezone,
          },
          startDate,
          endDate,
        );
        const existing = new Set(
          (
            await trx
              .selectFrom('events')
              .select('starts_at')
              .where('org_id', '=', org.id)
              .where('series_id', '=', series.id)
              .execute()
          ).map((event) => event.starts_at.toISOString()),
        );
        const template = series.template as never;
        for (const occurrence of occurrenceRows) {
          if (existing.has(new Date(occurrence.startsAt).toISOString()))
            continue;
          const candidate = {
            ...(template as EventCreateWithOverrideInput),
            startsAt: occurrence.startsAt,
            endsAt: occurrence.endsAt,
            timezone: series.timezone,
          } as EventCreateWithOverrideInput;
          const conflicts = await getConflicts(trx, actor, candidate);
          if (
            conflicts.some((conflict) => !conflict.overridable) ||
            (conflicts.some((conflict) => conflict.overridable) &&
              !candidate.overrideReason)
          ) {
            skippedConflicts += 1;
            continue;
          }
          await createSeriesOccurrenceInTransaction(
            trx,
            actor,
            series.id,
            template,
            occurrence.startsAt,
            occurrence.endsAt,
            series.timezone,
          );
          count += 1;
        }
      }
      return count;
    });
  }
  return { extended, skippedConflicts };
}

async function createSeriesOccurrenceInTransaction(
  trx: OrgTransaction,
  context: OrgContext,
  seriesId: string,
  template: {
    kind: string;
    title: string;
    programId?: string | null;
    divisionId?: string | null;
    spaceId?: string | null;
    locationText?: string | null;
    notesHtml?: string | null;
    arrivalMinutesBefore: number;
    participants: Array<{
      type: 'team' | 'person' | 'division' | 'external_team';
      id: string;
      side: 'home' | 'away' | 'none';
    }>;
    published: boolean;
  },
  startsAt: string,
  endsAt: string,
  timezone: string,
): Promise<void> {
  const id = newId();
  await trx
    .insertInto('events')
    .values({
      id,
      org_id: context.orgId,
      program_id: template.programId ?? null,
      division_id: template.divisionId ?? null,
      kind: template.kind,
      title: template.title,
      starts_at: new Date(startsAt),
      ends_at: new Date(endsAt),
      timezone,
      space_id: template.spaceId ?? null,
      location_text: template.locationText ?? null,
      notes_html: template.notesHtml ?? null,
      arrival_minutes_before: template.arrivalMinutesBefore,
      series_id: seriesId,
      published: template.published,
    })
    .execute();
  for (const participant of template.participants) {
    await trx
      .insertInto('event_participants')
      .values({
        id: newId(),
        org_id: context.orgId,
        event_id: id,
        team_season_id: participant.type === 'team' ? participant.id : null,
        external_team_id:
          participant.type === 'external_team' ? participant.id : null,
        person_id: participant.type === 'person' ? participant.id : null,
        division_id: participant.type === 'division' ? participant.id : null,
        side: participant.side,
      })
      .execute();
  }
  if (template.spaceId) {
    const { bufferMinutes } = await resolveTimezoneAndBuffer(
      trx,
      context.orgId,
      template.spaceId,
      template.programId,
    );
    await insertSpaceBooking(
      trx,
      context.orgId,
      template.spaceId,
      new Date(startsAt),
      new Date(endsAt),
      bufferMinutes,
      id,
    );
  }
  if (template.published) {
    const recipients = await eventRecipients(
      trx,
      context.orgId,
      template.participants,
    );
    await queueChangeBatch(
      trx,
      context,
      { id, title: template.title, startsAt, endsAt },
      recipients,
      'created',
    );
  }
}

export async function emitPendingScheduleBatches(): Promise<{
  emitted: number;
}> {
  const database = getDatabase();
  const orgs = await database
    .selectFrom('organizations')
    .select('id')
    .execute();
  let emitted = 0;
  const notificationModulePath: string = '../notifications/service';
  let notificationService: {
    createNotification: (
      trx: OrgTransaction,
      context: OrgContext,
      input: {
        accountId: string;
        type: 'schedule.changed' | 'safety.emergency';
        payload: unknown;
      },
    ) => Promise<string>;
  };
  try {
    notificationService = (await import(
      notificationModulePath
    )) as typeof notificationService;
  } catch {
    throw new Error(
      'Schedule change batches could not load the notifications service.',
    );
  }
  for (const org of orgs) {
    emitted += await withOrg(
      { orgId: org.id, actor: { accountId: newId() } },
      async (trx) => {
        const due = await trx
          .selectFrom('schedule_change_batches')
          .selectAll()
          .where('org_id', '=', org.id)
          .where('status', '=', 'pending')
          .where('emit_after', '<=', new Date())
          .orderBy('emit_after')
          .limit(200)
          .execute();
        let count = 0;
        for (const batch of due) {
          const context = {
            orgId: org.id,
            actor: { accountId: batch.created_by },
          };
          const notificationId = await notificationService.createNotification(
            trx,
            context,
            {
              accountId: batch.recipient_account_id,
              type: batch.notification_type as
                'schedule.changed' | 'safety.emergency',
              payload: {
                resourceType: 'schedule_change_batch',
                resourceId: batch.id,
                href: '/me/schedule',
              },
            },
          );
          await trx
            .updateTable('schedule_change_batches')
            .set({
              status: 'emitted',
              notification_id: notificationId,
              version: batch.version + 1,
            })
            .where('org_id', '=', org.id)
            .where('id', '=', batch.id)
            .where('version', '=', batch.version)
            .execute();
          if (batch.notification_type === 'safety.emergency') {
            const changes = Array.isArray(batch.changes)
              ? (batch.changes as Array<{ eventId?: string }>)
              : [];
            const eventIds = changes.flatMap((item) =>
              item.eventId ? [item.eventId] : [],
            );
            if (eventIds.length) {
              await trx
                .updateTable('closures')
                .set({ notified_at: new Date() })
                .where('org_id', '=', org.id)
                .where('notified_at', 'is', null)
                .where(
                  sql<boolean>`affected_event_ids && ${sql.val(eventIds)}::uuid[]`,
                )
                .execute();
            }
          }
          count += 1;
        }
        return count;
      },
    );
  }
  return { emitted };
}

export const scheduleJobHandlers = [
  { name: scheduleGenerationJob, run: runScheduleGeneration },
  {
    name: scheduleSeriesHorizonJob,
    cron: '0 4 * * *',
    run: extendRecurringSeries,
  },
  {
    name: scheduleBatchEmitJob,
    cron: '* * * * *',
    run: emitPendingScheduleBatches,
  },
] as const;
