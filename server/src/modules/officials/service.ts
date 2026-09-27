import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { checkCompliance } from '@shared/policies/compliance-gate';
import { expand, recurrenceSchema } from '@shared/recurrence';
import { sportProfileSchema } from '@shared/sport/schema';

import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { VersionConflictError } from '../../lib/version-check';
import { createNotification } from '../notifications/service';
import { assertSchedulePermission } from '../scheduling/access';
import { SchedulingRuleError } from '../scheduling/events';

type EventForAssignment = {
  contest_id: string;
  event_id: string;
  program_id: string | null;
  division_id: string | null;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  sport_profile_id: string;
  lat: number | null;
  lng: number | null;
  title: string;
};

async function admin(
  trx: OrgTransaction,
  context: OrgContext,
  programId?: string | null,
) {
  await assertSchedulePermission(
    trx,
    context,
    'officials.manage',
    programId ? { programId } : {},
  );
}

async function officialPersonForAccount(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<string> {
  const links = await trx
    .selectFrom('person_account_links')
    .select('person_id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('revoked_at', 'is', null)
    .where('verified_at', 'is not', null)
    .execute();
  for (const link of links) {
    const profile = await trx
      .selectFrom('official_profiles')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', link.person_id)
      .where('active', '=', true)
      .executeTakeFirst();
    if (profile) return link.person_id;
  }
  throw new SchedulingRuleError(
    'An active official profile is required for this action.',
    403,
    'FORBIDDEN',
  );
}

async function eventForContest(
  trx: OrgTransaction,
  orgId: string,
  contestId: string,
): Promise<EventForAssignment> {
  const row = await trx
    .selectFrom('contests')
    .innerJoin('events', (join) =>
      join
        .onRef('events.org_id', '=', 'contests.org_id')
        .onRef('events.id', '=', 'contests.event_id'),
    )
    .leftJoin('spaces', (join) =>
      join
        .onRef('spaces.org_id', '=', 'events.org_id')
        .onRef('spaces.id', '=', 'events.space_id'),
    )
    .leftJoin('facilities', (join) =>
      join
        .onRef('facilities.org_id', '=', 'spaces.org_id')
        .onRef('facilities.id', '=', 'spaces.facility_id'),
    )
    .select([
      'contests.id as contest_id',
      'events.id as event_id',
      'events.program_id',
      'events.division_id',
      'events.starts_at',
      'events.ends_at',
      'events.timezone',
      'contests.sport_profile_id',
      'facilities.lat',
      'facilities.lng',
      'events.title',
    ])
    .where('contests.org_id', '=', orgId)
    .where('contests.id', '=', contestId)
    .executeTakeFirst();
  if (!row)
    throw new SchedulingRuleError('Contest not found.', 404, 'NOT_FOUND');
  return {
    ...row,
    lat: row.lat,
    lng: row.lng,
  };
}

function localDate(event: EventForAssignment): string {
  return Temporal.Instant.from(event.starts_at.toISOString())
    .toZonedDateTimeISO(event.timezone)
    .toPlainDate()
    .toString();
}
function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

async function complianceFor(
  trx: OrgTransaction,
  orgId: string,
  personId: string,
  programId: string | null,
  onDate: string,
) {
  const person = await trx
    .selectFrom('people')
    .select('date_of_birth')
    .where('org_id', '=', orgId)
    .where('id', '=', personId)
    .executeTakeFirstOrThrow();
  const requirementsQuery = trx
    .selectFrom('role_credential_requirements')
    .select('credential_type_id')
    .where('org_id', '=', orgId)
    .where('role', '=', 'official')
    .where('active', '=', true);
  const requirements = programId
    ? await requirementsQuery
        .where((eb) =>
          eb.or([
            eb('scope_type', '=', 'org'),
            eb.and([
              eb('scope_type', '=', 'program'),
              eb('scope_id', '=', programId),
            ]),
          ]),
        )
        .execute()
    : await requirementsQuery.where('scope_type', '=', 'org').execute();
  const credentialRows = requirements.length
    ? await trx
        .selectFrom('person_credentials')
        .select(['credential_type_id', 'status', 'expires_on'])
        .where('org_id', '=', orgId)
        .where('person_id', '=', personId)
        .where(
          'credential_type_id',
          'in',
          requirements.map((row) => row.credential_type_id),
        )
        .execute()
    : [];
  const result = checkCompliance({
    requirements: requirements.map((row) => ({
      typeId: row.credential_type_id,
    })),
    credentials: credentialRows.map((row) => ({
      typeId: row.credential_type_id,
      status: row.status as
        'pending_review' | 'verified' | 'rejected' | 'expired' | 'revoked',
      expiresOn: row.expires_on?.toString() ?? null,
    })),
    dateOfBirth: person.date_of_birth.toISOString().slice(0, 10),
    minimumAge: 0,
    onDate,
  });
  if (!result.eligible)
    throw new SchedulingRuleError(
      `Official does not meet the active compliance requirements: ${result.missing.map((item) => item.code).join(', ')}.`,
      403,
      'FORBIDDEN',
      { compliance: result.missing },
    );
  return result;
}

async function assertAvailableAndUnconflicted(
  trx: OrgTransaction,
  orgId: string,
  personId: string,
  event: EventForAssignment,
  profile: {
    max_games_per_day: number | null;
    travel_radius_km: number | null;
    home_lat: number | null;
    home_lng: number | null;
  },
  excludingAssignmentId?: string,
) {
  const date = localDate(event);
  const availability = await trx
    .selectFrom('official_availability')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('person_id', '=', personId)
    .execute();
  const activeAvailability = availability.filter((window) => {
    if (window.recurrence) {
      const recurrence = recurrenceSchema.parse(window.recurrence);
      return (
        expand(
          {
            recurrence,
            startTime: '00:00',
            durationMinutes: 1,
            timezone: 'UTC',
          },
          date,
          date,
        ).length > 0
      );
    }
    return (
      (!window.starts_on || window.starts_on.toString() <= date) &&
      (!window.ends_on || window.ends_on.toString() >= date)
    );
  });
  if (activeAvailability.some((window) => !window.available))
    throw new SchedulingRuleError(
      'Official marked unavailable for this game.',
      409,
      'SCHEDULE_CONFLICT',
    );
  if (
    !activeAvailability.some((window) => window.available) &&
    availability.length
  )
    throw new SchedulingRuleError(
      'Official has not marked availability for this date.',
      409,
      'SCHEDULE_CONFLICT',
    );
  if (profile.travel_radius_km !== null) {
    if (
      profile.home_lat === null ||
      profile.home_lng === null ||
      event.lat === null ||
      event.lng === null
    )
      throw new SchedulingRuleError(
        'Travel radius is configured but an official home or facility location is missing.',
        409,
        'SCHEDULE_CONFLICT',
      );
    if (
      haversineKm(
        { lat: profile.home_lat, lng: profile.home_lng },
        { lat: event.lat, lng: event.lng },
      ) > profile.travel_radius_km
    )
      throw new SchedulingRuleError(
        'Game is outside this official’s configured travel radius.',
        409,
        'SCHEDULE_CONFLICT',
      );
  }
  const assignments = await trx
    .selectFrom('official_assignments')
    .innerJoin('contests', (join) =>
      join
        .onRef('contests.org_id', '=', 'official_assignments.org_id')
        .onRef('contests.id', '=', 'official_assignments.contest_id'),
    )
    .innerJoin('events', (join) =>
      join
        .onRef('events.org_id', '=', 'contests.org_id')
        .onRef('events.id', '=', 'contests.event_id'),
    )
    .leftJoin('spaces', (join) =>
      join
        .onRef('spaces.org_id', '=', 'events.org_id')
        .onRef('spaces.id', '=', 'events.space_id'),
    )
    .leftJoin('facilities', (join) =>
      join
        .onRef('facilities.org_id', '=', 'spaces.org_id')
        .onRef('facilities.id', '=', 'spaces.facility_id'),
    )
    .select([
      'official_assignments.id',
      'events.id as event_id',
      'events.starts_at',
      'events.ends_at',
      'events.timezone',
      'facilities.lat',
      'facilities.lng',
    ])
    .where('official_assignments.org_id', '=', orgId)
    .where('official_assignments.person_id', '=', personId)
    .where('official_assignments.status', 'not in', [
      'declined',
      'canceled',
      'no_show',
    ])
    .where('events.status', 'not in', ['canceled', 'completed'])
    .execute();
  const conflicts = assignments.filter(
    (item) =>
      item.id !== excludingAssignmentId &&
      new Date(item.starts_at) < event.ends_at &&
      new Date(item.ends_at) > event.starts_at,
  );
  if (conflicts.length)
    throw new SchedulingRuleError(
      'Official already has an overlapping assignment.',
      409,
      'SCHEDULE_CONFLICT',
      { assignmentIds: conflicts.map((item) => item.id) },
    );
  const sameDay = assignments.filter(
    (item) =>
      item.id !== excludingAssignmentId &&
      localDate({
        ...event,
        starts_at: new Date(item.starts_at),
        ends_at: new Date(item.ends_at),
        timezone: item.timezone,
      }) === date,
  );
  if (profile.max_games_per_day && sameDay.length >= profile.max_games_per_day)
    throw new SchedulingRuleError(
      'Official has reached their daily game limit.',
      409,
      'SCHEDULE_CONFLICT',
    );
  for (const other of assignments.filter(
    (item) => item.id !== excludingAssignmentId,
  )) {
    const otherEnd = new Date(other.ends_at);
    const otherStart = new Date(other.starts_at);
    if (
      otherEnd <= event.starts_at &&
      event.starts_at.getTime() - otherEnd.getTime() < 90 * 60 * 1000 &&
      event.lat !== null &&
      event.lng !== null &&
      other.lat !== null &&
      other.lng !== null
    ) {
      const distance = haversineKm(
        { lat: other.lat, lng: other.lng },
        { lat: event.lat, lng: event.lng },
      );
      if (
        (distance / 50) * 60 >
        (event.starts_at.getTime() - otherEnd.getTime()) / 60000
      )
        throw new SchedulingRuleError(
          'Travel time between assignments is not feasible.',
          409,
          'SCHEDULE_CONFLICT',
        );
    }
    if (
      event.ends_at <= otherStart &&
      otherStart.getTime() - event.ends_at.getTime() < 90 * 60 * 1000 &&
      event.lat !== null &&
      event.lng !== null &&
      other.lat !== null &&
      other.lng !== null
    ) {
      const distance = haversineKm(
        { lat: event.lat, lng: event.lng },
        { lat: other.lat, lng: other.lng },
      );
      if (
        (distance / 50) * 60 >
        (otherStart.getTime() - event.ends_at.getTime()) / 60000
      )
        throw new SchedulingRuleError(
          'Travel time between assignments is not feasible.',
          409,
          'SCHEDULE_CONFLICT',
        );
    }
  }
}

async function feeForPosition(
  trx: OrgTransaction,
  orgId: string,
  personId: string,
  programId: string | null,
  divisionId: string | null,
  positionKey: string,
): Promise<number> {
  const profile = await trx
    .selectFrom('official_profiles')
    .select('pay_rates')
    .where('org_id', '=', orgId)
    .where('person_id', '=', personId)
    .executeTakeFirstOrThrow();
  const rates = (profile.pay_rates ?? {}) as Record<string, unknown>;
  const candidates = [
    divisionId ? `${divisionId}:${positionKey}` : '',
    programId ? `${programId}:${positionKey}` : '',
    positionKey,
    'default',
  ].filter(Boolean);
  for (const key of candidates) {
    const value = rates[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      return value;
    if (
      value &&
      typeof value === 'object' &&
      'feeCents' in value &&
      typeof value.feeCents === 'number' &&
      Number.isSafeInteger(value.feeCents) &&
      value.feeCents >= 0
    )
      return value.feeCents;
  }
  return 0;
}

export async function saveOfficialProfile(
  context: OrgContext,
  input: {
    personId: string;
    grade?: string | null;
    level?: string | null;
    sports: string[];
    maxGamesPerDay?: number | null;
    homeArea?: string | null;
    homeLat?: number | null;
    homeLng?: number | null;
    travelRadiusKm?: number | null;
    payRates: Record<string, unknown>;
    active: boolean;
    expectedVersion?: number;
  },
) {
  return withOrg(context, async (trx) => {
    await admin(trx, context);
    const sports = input.sports.length
      ? await trx
          .selectFrom('sport_profiles')
          .select(['id', 'profile'])
          .where('org_id', '=', context.orgId)
          .where('id', 'in', input.sports)
          .where('archived_at', 'is', null)
          .execute()
      : [];
    if (sports.length !== new Set(input.sports).size)
      throw new SchedulingRuleError(
        'Every selected sport profile must be active in this organization.',
      );
    const existing = await trx
      .selectFrom('official_profiles')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', input.personId)
      .executeTakeFirst();
    if ((existing?.version ?? 0) !== (input.expectedVersion ?? 0))
      throw new VersionConflictError(
        existing ?? { version: 0, personId: input.personId },
      );
    if ((input.homeLat == null) !== (input.homeLng == null))
      throw new SchedulingRuleError(
        'Home latitude and longitude must be provided together.',
      );
    const base = {
      grade: input.grade ?? null,
      level: input.level ?? null,
      sports: input.sports,
      max_games_per_day: input.maxGamesPerDay ?? null,
      home_area: input.homeArea ?? null,
      home_lat: input.homeLat ?? null,
      home_lng: input.homeLng ?? null,
      travel_radius_km: input.travelRadiusKm ?? null,
      pay_rates: input.payRates as import('../../db/types').Json,
      active: input.active,
    };
    let profile;
    if (existing)
      profile = await trx
        .updateTable('official_profiles')
        .set({ ...base, version: existing.version + 1 })
        .where('org_id', '=', context.orgId)
        .where('id', '=', existing.id)
        .where('version', '=', existing.version)
        .returningAll()
        .executeTakeFirstOrThrow();
    else
      profile = await trx
        .insertInto('official_profiles')
        .values({
          id: newId(),
          org_id: context.orgId,
          person_id: input.personId,
          ...base,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    for (const sport of sports) {
      const sportProfile = sportProfileSchema.parse(sport.profile);
      for (const [index, position] of sportProfile.officials.entries()) {
        const old = await trx
          .selectFrom('official_positions')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('sport_profile_id', '=', sport.id)
          .where('key', '=', position.key)
          .executeTakeFirst();
        if (!old)
          await trx
            .insertInto('official_positions')
            .values({
              id: newId(),
              org_id: context.orgId,
              sport_profile_id: sport.id,
              key: position.key,
              name: position.label.en,
              sort_order: index,
            })
            .execute();
      }
    }
    return profile;
  });
}

export async function listOfficials(
  context: OrgContext,
  input: { programId?: string; active?: boolean },
) {
  return withOrg(context, async (trx) => {
    await admin(trx, context, input.programId);
    let query = trx
      .selectFrom('official_profiles')
      .innerJoin('people', (join) =>
        join
          .onRef('people.org_id', '=', 'official_profiles.org_id')
          .onRef('people.id', '=', 'official_profiles.person_id'),
      )
      .select([
        'official_profiles.id',
        'official_profiles.person_id',
        'official_profiles.grade',
        'official_profiles.level',
        'official_profiles.sports',
        'official_profiles.max_games_per_day',
        'official_profiles.home_area',
        'official_profiles.travel_radius_km',
        'official_profiles.pay_rates',
        'official_profiles.active',
        'official_profiles.version',
        'people.first_name',
        'people.last_name',
      ])
      .where('official_profiles.org_id', '=', context.orgId);
    if (input.active !== undefined)
      query = query.where('official_profiles.active', '=', input.active);
    return query
      .orderBy('people.last_name')
      .orderBy('people.first_name')
      .execute();
  });
}

export async function setOfficialAvailability(
  context: OrgContext,
  input: {
    personId?: string;
    available: boolean;
    recurrence?: unknown;
    startsOn?: string | null;
    endsOn?: string | null;
  },
) {
  return withOrg(context, async (trx) => {
    let personId = input.personId;
    if (personId) await admin(trx, context);
    else {
      personId = await officialPersonForAccount(trx, context);
      await assertSchedulePermission(trx, context, 'officials.self', {
        personId,
      });
    }
    if (input.recurrence) {
      const recurrence = recurrenceSchema.parse(input.recurrence);
      return trx
        .insertInto('official_availability')
        .values({
          id: newId(),
          org_id: context.orgId,
          person_id: personId,
          available: input.available,
          recurrence: recurrence as unknown as import('../../db/types').Json,
          starts_on: null,
          ends_on: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    if (!input.startsOn || !input.endsOn || input.startsOn > input.endsOn)
      throw new SchedulingRuleError(
        'Provide a valid availability date range or recurrence.',
      );
    return trx
      .insertInto('official_availability')
      .values({
        id: newId(),
        org_id: context.orgId,
        person_id: personId,
        available: input.available,
        recurrence: null,
        starts_on: input.startsOn,
        ends_on: input.endsOn,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function assignmentBoard(
  context: OrgContext,
  input: { from: Date; to: Date; programId?: string },
) {
  return withOrg(context, async (trx) => {
    await admin(trx, context, input.programId);
    let query = trx
      .selectFrom('contests')
      .innerJoin('events', (join) =>
        join
          .onRef('events.org_id', '=', 'contests.org_id')
          .onRef('events.id', '=', 'contests.event_id'),
      )
      .select([
        'contests.id as contest_id',
        'contests.sport_profile_id',
        'events.id as event_id',
        'events.title',
        'events.starts_at',
        'events.ends_at',
        'events.timezone',
        'events.program_id',
        'events.division_id',
      ])
      .where('contests.org_id', '=', context.orgId)
      .where('events.starts_at', '>=', input.from)
      .where('events.starts_at', '<', input.to)
      .where('events.status', 'not in', ['canceled', 'completed']);
    if (input.programId)
      query = query.where('events.program_id', '=', input.programId);
    const games = await query.orderBy('events.starts_at').execute();
    const ids = games.map((game) => game.contest_id);
    const assignments = ids.length
      ? await trx
          .selectFrom('official_assignments')
          .innerJoin('people', (join) =>
            join
              .onRef('people.org_id', '=', 'official_assignments.org_id')
              .onRef('people.id', '=', 'official_assignments.person_id'),
          )
          .select([
            'official_assignments.id',
            'official_assignments.contest_id',
            'official_assignments.position_key',
            'official_assignments.person_id',
            'official_assignments.status',
            'official_assignments.fee_cents',
            'official_assignments.mileage_cents',
            'official_assignments.version',
            'people.first_name',
            'people.last_name',
          ])
          .where('official_assignments.org_id', '=', context.orgId)
          .where('official_assignments.contest_id', 'in', ids)
          .where('official_assignments.status', '!=', 'canceled')
          .execute()
      : [];
    const profileIds = [...new Set(games.map((game) => game.sport_profile_id))];
    const positions = profileIds.length
      ? await trx
          .selectFrom('official_positions')
          .select(['sport_profile_id', 'key', 'name', 'sort_order'])
          .where('org_id', '=', context.orgId)
          .where('sport_profile_id', 'in', profileIds)
          .orderBy('sort_order')
          .execute()
      : [];
    return {
      games: games.map((game) => ({
        ...game,
        assignments: assignments.filter(
          (assignment) => assignment.contest_id === game.contest_id,
        ),
        requiredPositions: positions.filter(
          (position) => position.sport_profile_id === game.sport_profile_id,
        ),
      })),
    };
  });
}

async function createAssignment(
  trx: OrgTransaction,
  context: OrgContext,
  input: {
    contestId: string;
    personId: string;
    positionKey: string;
    mileageCents?: number;
  },
  requireManager: boolean,
) {
  const event = await eventForContest(trx, context.orgId, input.contestId);
  if (requireManager) await admin(trx, context, event.program_id);
  const [profile, position] = await Promise.all([
    trx
      .selectFrom('official_profiles')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', input.personId)
      .where('active', '=', true)
      .executeTakeFirst(),
    trx
      .selectFrom('official_positions')
      .select('key')
      .where('org_id', '=', context.orgId)
      .where('sport_profile_id', '=', event.sport_profile_id)
      .where('key', '=', input.positionKey)
      .executeTakeFirst(),
  ]);
  if (!profile || !profile.sports.includes(event.sport_profile_id))
    throw new SchedulingRuleError(
      'Official is not active for this sport.',
      409,
      'CONFLICT',
    );
  if (!position)
    throw new SchedulingRuleError(
      'Position is not configured for this sport profile.',
      400,
    );
  const assigned = await trx
    .selectFrom('official_assignments')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('contest_id', '=', input.contestId)
    .where('position_key', '=', input.positionKey)
    .where('status', 'in', ['offered', 'accepted', 'confirmed'])
    .executeTakeFirst();
  if (assigned)
    throw new SchedulingRuleError(
      'This position already has an active assignment.',
      409,
      'CONFLICT',
    );
  await complianceFor(
    trx,
    context.orgId,
    input.personId,
    event.program_id,
    localDate(event),
  );
  await assertAvailableAndUnconflicted(
    trx,
    context.orgId,
    input.personId,
    event,
    profile,
  );
  const feeCents = await feeForPosition(
    trx,
    context.orgId,
    input.personId,
    event.program_id,
    event.division_id,
    input.positionKey,
  );
  const assignment = await trx
    .insertInto('official_assignments')
    .values({
      id: newId(),
      org_id: context.orgId,
      contest_id: input.contestId,
      person_id: input.personId,
      position_key: input.positionKey,
      status: requireManager ? 'offered' : 'accepted',
      responded_at: requireManager ? null : new Date(),
      fee_cents: feeCents,
      mileage_cents: input.mileageCents ?? 0,
      assigned_by: context.actor.accountId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const recipient = await trx
    .selectFrom('person_account_links')
    .select('account_id')
    .where('org_id', '=', context.orgId)
    .where('person_id', '=', input.personId)
    .where('relationship', '=', 'self')
    .where('verified_at', 'is not', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!recipient)
    throw new SchedulingRuleError(
      'The official needs a verified account before receiving an assignment offer.',
      409,
      'CONFLICT',
    );
  if (!requireManager) return assignment;
  try {
    await createNotification(trx, context, {
      accountId: recipient.account_id,
      type: 'official_assignment.offered',
      payload: { assignmentId: assignment.id },
    });
  } catch {
    throw new SchedulingRuleError(
      'The official assignment offer notification could not be recorded.',
      503,
      'SCHEDULE_CONFLICT',
    );
  }
  return assignment;
}

export async function assignOfficial(
  context: OrgContext,
  input: {
    contestId: string;
    personId: string;
    positionKey: string;
    mileageCents?: number;
  },
) {
  return withOrg(context, async (trx) => {
    return createAssignment(trx, context, input, true);
  });
}

export async function respondToAssignment(
  context: OrgContext,
  assignmentId: string,
  expectedVersion: number,
  response: 'accepted' | 'declined',
) {
  return withOrg(context, async (trx) => {
    const personId = await officialPersonForAccount(trx, context);
    const assignment = await trx
      .selectFrom('official_assignments')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', assignmentId)
      .where('person_id', '=', personId)
      .executeTakeFirst();
    if (!assignment)
      throw new SchedulingRuleError('Assignment not found.', 404, 'NOT_FOUND');
    if (assignment.version !== expectedVersion)
      throw new VersionConflictError(assignment);
    if (assignment.status !== 'offered')
      throw new SchedulingRuleError(
        'Only an open offer can be accepted or declined.',
        409,
        'CONFLICT',
      );
    if (response === 'accepted') {
      const event = await eventForContest(
        trx,
        context.orgId,
        assignment.contest_id,
      );
      const profile = await trx
        .selectFrom('official_profiles')
        .selectAll()
        .where('org_id', '=', context.orgId)
        .where('person_id', '=', personId)
        .executeTakeFirstOrThrow();
      await complianceFor(
        trx,
        context.orgId,
        personId,
        event.program_id,
        localDate(event),
      );
      await assertAvailableAndUnconflicted(
        trx,
        context.orgId,
        personId,
        event,
        profile,
        assignment.id,
      );
    }
    const updated = await trx
      .updateTable('official_assignments')
      .set({
        status: response,
        responded_at: new Date(),
        version: assignment.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', assignmentId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirstOrThrow();
    try {
      await createNotification(trx, context, {
        accountId: assignment.assigned_by,
        type: 'official_assignment.changed',
        payload: { assignmentId },
      });
    } catch {
      throw new SchedulingRuleError(
        'The official assignment response notification could not be recorded.',
        503,
        'SCHEDULE_CONFLICT',
      );
    }
    return updated;
  });
}

export async function confirmOfficialAssignment(
  context: OrgContext,
  assignmentId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    const assignment = await trx
      .selectFrom('official_assignments')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', assignmentId)
      .executeTakeFirst();
    if (!assignment)
      throw new SchedulingRuleError('Assignment not found.', 404, 'NOT_FOUND');
    const event = await eventForContest(
      trx,
      context.orgId,
      assignment.contest_id,
    );
    await admin(trx, context, event.program_id);
    if (assignment.version !== expectedVersion)
      throw new VersionConflictError(assignment);
    if (assignment.status !== 'accepted')
      throw new SchedulingRuleError(
        'Only an accepted assignment can be confirmed.',
        409,
        'CONFLICT',
      );
    const updated = await trx
      .updateTable('official_assignments')
      .set({ status: 'confirmed', version: assignment.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', assignmentId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirstOrThrow();
    const recipient = await trx
      .selectFrom('person_account_links')
      .select('account_id')
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', assignment.person_id)
      .where('relationship', '=', 'self')
      .where('verified_at', 'is not', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (recipient) {
      try {
        await createNotification(trx, context, {
          accountId: recipient.account_id,
          type: 'official_assignment.changed',
          payload: { assignmentId },
        });
      } catch {
        throw new SchedulingRuleError(
          'The official assignment confirmation notification could not be recorded.',
          503,
          'SCHEDULE_CONFLICT',
        );
      }
    }
    return updated;
  });
}

export async function listMyAssignments(context: OrgContext) {
  return withOrg(context, async (trx) => {
    const personId = await officialPersonForAccount(trx, context);
    return trx
      .selectFrom('official_assignments')
      .innerJoin('contests', (join) =>
        join
          .onRef('contests.org_id', '=', 'official_assignments.org_id')
          .onRef('contests.id', '=', 'official_assignments.contest_id'),
      )
      .innerJoin('events', (join) =>
        join
          .onRef('events.org_id', '=', 'contests.org_id')
          .onRef('events.id', '=', 'contests.event_id'),
      )
      .select([
        'official_assignments.id',
        'official_assignments.contest_id',
        'official_assignments.position_key',
        'official_assignments.status',
        'official_assignments.version',
        'official_assignments.fee_cents',
        'official_assignments.mileage_cents',
        'events.title',
        'events.starts_at',
        'events.ends_at',
        'events.timezone',
        'events.location_text',
      ])
      .where('official_assignments.org_id', '=', context.orgId)
      .where('official_assignments.person_id', '=', personId)
      .where('official_assignments.status', 'not in', ['canceled', 'declined'])
      .orderBy('events.starts_at')
      .execute();
  });
}

export async function selfAssign(
  context: OrgContext,
  contestId: string,
  positionKey: string,
) {
  return withOrg(context, async (trx) => {
    const personId = await officialPersonForAccount(trx, context);
    await assertSchedulePermission(trx, context, 'officials.self', {
      personId,
    });
    const event = await eventForContest(trx, context.orgId, contestId);
    const setting = event.program_id
      ? await trx
          .selectFrom('schedule_settings')
          .select('official_self_assign_enabled')
          .where('org_id', '=', context.orgId)
          .where('program_id', '=', event.program_id)
          .executeTakeFirst()
      : null;
    if (!setting?.official_self_assign_enabled)
      throw new SchedulingRuleError(
        'Self-assignment is not enabled for this program.',
        403,
        'FORBIDDEN',
      );
    return createAssignment(
      trx,
      context,
      { contestId, personId, positionKey },
      false,
    );
  });
}

export async function submitGameReport(
  context: OrgContext,
  contestId: string,
  input: {
    bodyHtml: string;
    incidents: Array<{ kind: string; description: string }>;
  },
) {
  return withOrg(context, async (trx) => {
    const personId = await officialPersonForAccount(trx, context);
    const assigned = await trx
      .selectFrom('official_assignments')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('contest_id', '=', contestId)
      .where('person_id', '=', personId)
      .where('status', 'in', ['accepted', 'confirmed'])
      .executeTakeFirst();
    if (!assigned)
      throw new SchedulingRuleError(
        'Only an assigned official may submit an official game report.',
        403,
        'FORBIDDEN',
      );
    return trx
      .insertInto('game_reports')
      .values({
        id: newId(),
        org_id: context.orgId,
        contest_id: contestId,
        submitted_by: context.actor.accountId,
        role: 'official',
        body_html: input.bodyHtml,
        incidents: input.incidents as unknown as import('../../db/types').Json,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function markOfficialNoShow(
  context: OrgContext,
  assignmentId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    const assignment = await trx
      .selectFrom('official_assignments')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', assignmentId)
      .executeTakeFirst();
    if (!assignment)
      throw new SchedulingRuleError('Assignment not found.', 404, 'NOT_FOUND');
    const event = await eventForContest(
      trx,
      context.orgId,
      assignment.contest_id,
    );
    await admin(trx, context, event.program_id);
    if (assignment.version !== expectedVersion)
      throw new VersionConflictError(assignment);
    if (event.ends_at > new Date())
      throw new SchedulingRuleError(
        'A no-show can be recorded after the contest ends.',
        409,
        'CONFLICT',
      );
    return trx
      .updateTable('official_assignments')
      .set({ status: 'no_show', version: assignment.version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', assignmentId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function createPayBatch(
  context: OrgContext,
  input: { periodStart: string; periodEnd: string },
) {
  return withOrg(context, async (trx) => {
    await admin(trx, context);
    if (input.periodStart > input.periodEnd)
      throw new SchedulingRuleError('Pay period ends before it starts.');
    const batchId = newId();
    const batch = await trx
      .insertInto('official_pay_batches')
      .values({
        id: batchId,
        org_id: context.orgId,
        period_start: input.periodStart,
        period_end: input.periodEnd,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const periodEndExclusive = new Date(`${input.periodEnd}T00:00:00.000Z`);
    periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);
    const assignments = await trx
      .selectFrom('official_assignments')
      .innerJoin('contests', (join) =>
        join
          .onRef('contests.org_id', '=', 'official_assignments.org_id')
          .onRef('contests.id', '=', 'official_assignments.contest_id'),
      )
      .innerJoin('events', (join) =>
        join
          .onRef('events.org_id', '=', 'contests.org_id')
          .onRef('events.id', '=', 'contests.event_id'),
      )
      .select([
        'official_assignments.id',
        'official_assignments.person_id',
        'official_assignments.fee_cents',
        'official_assignments.mileage_cents',
      ])
      .where('official_assignments.org_id', '=', context.orgId)
      .where('official_assignments.status', 'in', ['accepted', 'confirmed'])
      .where('events.ends_at', '<', new Date())
      .where('events.ends_at', '>=', new Date(`${input.periodStart}T00:00:00Z`))
      .where('events.ends_at', '<', periodEndExclusive)
      .execute();
    for (const assignment of assignments) {
      const exists = await trx
        .selectFrom('official_pay_lines')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('assignment_id', '=', assignment.id)
        .executeTakeFirst();
      if (exists) continue;
      await trx
        .insertInto('official_pay_lines')
        .values({
          id: newId(),
          org_id: context.orgId,
          batch_id: batchId,
          person_id: assignment.person_id,
          assignment_id: assignment.id,
          fee_cents: assignment.fee_cents,
          mileage_cents: assignment.mileage_cents,
        })
        .execute();
    }
    const lines = await trx
      .selectFrom('official_pay_lines')
      .select(['id', 'person_id', 'fee_cents', 'mileage_cents', 'total_cents'])
      .where('org_id', '=', context.orgId)
      .where('batch_id', '=', batchId)
      .execute();
    return {
      batch,
      lines,
      totalCents: lines.reduce(
        (sum, line) =>
          sum + (line.total_cents ?? line.fee_cents + line.mileage_cents),
        0,
      ),
    };
  });
}

export async function approvePayBatch(
  context: OrgContext,
  batchId: string,
  expectedVersion: number,
) {
  return withOrg(context, async (trx) => {
    await admin(trx, context);
    const batch = await trx
      .selectFrom('official_pay_batches')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', batchId)
      .executeTakeFirst();
    if (!batch)
      throw new SchedulingRuleError('Pay batch not found.', 404, 'NOT_FOUND');
    if (batch.version !== expectedVersion)
      throw new VersionConflictError(batch);
    if (batch.status !== 'draft')
      throw new SchedulingRuleError(
        'Only a draft pay batch may be approved.',
        409,
        'CONFLICT',
      );
    const lines = await trx
      .selectFrom('official_pay_lines')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('batch_id', '=', batchId)
      .execute();
    if (!lines.length)
      throw new SchedulingRuleError(
        'An empty pay batch cannot be approved.',
        409,
        'CONFLICT',
      );
    return trx
      .updateTable('official_pay_batches')
      .set({
        status: 'approved',
        approved_by: context.actor.accountId,
        approved_at: new Date(),
        version: batch.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', batchId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function markPayBatchPaid(
  context: OrgContext,
  batchId: string,
  expectedVersion: number,
  input: { paidVia: 'external' | 'check' | 'other'; reference?: string },
) {
  return withOrg(context, async (trx) => {
    await admin(trx, context);
    const batch = await trx
      .selectFrom('official_pay_batches')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', batchId)
      .executeTakeFirst();
    if (!batch)
      throw new SchedulingRuleError('Pay batch not found.', 404, 'NOT_FOUND');
    if (batch.version !== expectedVersion)
      throw new VersionConflictError(batch);
    if (batch.status !== 'approved')
      throw new SchedulingRuleError(
        'Approve a pay batch before recording its external payment.',
        409,
        'CONFLICT',
      );
    return trx
      .updateTable('official_pay_batches')
      .set({
        status: 'paid',
        paid_via: input.paidVia,
        paid_at: new Date(),
        paid_by: context.actor.accountId,
        payment_reference: input.reference ?? null,
        version: batch.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', batchId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function officialYearlyTotals(context: OrgContext, year: number) {
  return withOrg(context, async (trx) => {
    await admin(trx, context);
    const lines = await trx
      .selectFrom('official_pay_lines')
      .innerJoin('official_pay_batches', (join) =>
        join
          .onRef(
            'official_pay_batches.org_id',
            '=',
            'official_pay_lines.org_id',
          )
          .onRef('official_pay_batches.id', '=', 'official_pay_lines.batch_id'),
      )
      .innerJoin('people', (join) =>
        join
          .onRef('people.org_id', '=', 'official_pay_lines.org_id')
          .onRef('people.id', '=', 'official_pay_lines.person_id'),
      )
      .select([
        'official_pay_lines.person_id',
        'people.first_name',
        'people.last_name',
        'official_pay_lines.total_cents',
        'official_pay_lines.fee_cents',
        'official_pay_lines.mileage_cents',
        'official_pay_batches.period_start',
      ])
      .where('official_pay_lines.org_id', '=', context.orgId)
      .where('official_pay_batches.status', 'in', ['approved', 'paid'])
      .where(
        'official_pay_batches.period_start',
        '>=',
        new Date(`${String(year)}-01-01T00:00:00.000Z`),
      )
      .where(
        'official_pay_batches.period_start',
        '<=',
        new Date(`${String(year)}-12-31T00:00:00.000Z`),
      )
      .execute();
    const totals = new Map<
      string,
      {
        personId: string;
        firstName: string;
        lastName: string;
        totalCents: number;
        assignmentCount: number;
      }
    >();
    for (const line of lines) {
      const row = totals.get(line.person_id) ?? {
        personId: line.person_id,
        firstName: line.first_name,
        lastName: line.last_name,
        totalCents: 0,
        assignmentCount: 0,
      };
      row.totalCents += line.total_cents ?? line.fee_cents + line.mileage_cents;
      row.assignmentCount += 1;
      totals.set(line.person_id, row);
    }
    return [...totals.values()].sort((a, b) => b.totalCents - a.totalCents);
  });
}

export async function exportOfficialsCsv(
  context: OrgContext,
  year: number,
): Promise<string> {
  const rows = await officialYearlyTotals(context, year);
  const cell = (value: unknown) => {
    const text =
      value == null
        ? ''
        : typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : JSON.stringify(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return (
    [
      'person_id,first_name,last_name,assignment_count,total_cents',
      ...rows.map((row) =>
        [
          row.personId,
          row.firstName,
          row.lastName,
          row.assignmentCount,
          row.totalCents,
        ]
          .map(cell)
          .join(','),
      ),
    ].join('\r\n') + '\r\n'
  );
}

export async function testComplianceForOfficial(
  trx: OrgTransaction,
  context: OrgContext,
  personId: string,
  programId: string | null,
  date: string,
) {
  return complianceFor(trx, context.orgId, personId, programId, date);
}
