import { newId } from '@shared/ids';
import { expand } from '@shared/recurrence';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';

import { federationNotFound, federationUnprocessable } from './errors';
import { getFederationAdminDatabase } from './privileged';

export interface ContributionWindow {
  id: string;
  relationshipId: string;
  spaceId: string;
  spaceName: string;
  facilityName: string;
  startsAt: string;
  endsAt: string;
  status: string;
  notes: string | null;
}

export interface FederationSpace {
  id: string;
  ownerOrgId: string;
  facilityId: string;
  name: string;
  availability: { startsAt: string; endsAt: string }[];
  bookings: { startsAt: string; endsAt: string }[];
}

/**
 * Expand the spine's structured recurrence into concrete instants for the
 * federation adapter using the same timezone rules as Track G.
 */
export function expandAvailabilityWindows(input: {
  recurrence: unknown;
  startsOn: string;
  endsOn: string;
  startTime: string;
  endTime: string;
  timezone: string;
  maxWindows?: number;
}): { startsAt: string; endsAt: string }[] {
  const durationMinutes =
    (Date.parse(`1970-01-01T${input.endTime}Z`) -
      Date.parse(`1970-01-01T${input.startTime}Z`)) /
    60_000;
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) return [];
  try {
    return expand(
      {
        recurrence: input.recurrence as never,
        startTime: input.startTime,
        durationMinutes,
        timezone: input.timezone,
      },
      input.startsOn,
      input.endsOn,
    )
      .slice(0, input.maxWindows ?? 366)
      .map(({ startsAt, endsAt }) => ({ startsAt, endsAt }));
  } catch {
    return [];
  }
}

/**
 * Club contributes member-club field windows to the league's scheduling pool.
 * Rows live in the CLUB org — the league can only read them through the
 * privileged scheduling path.
 */
export async function offerSpaceWindows(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    relationshipId: string;
    spaceId: string;
    windows: readonly { startsAt: string; endsAt: string }[];
    notes?: string | undefined;
  },
): Promise<{ created: number }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const relationship = await trx
      .selectFrom('org_relationships')
      .selectAll()
      .where('id', '=', input.relationshipId)
      .where('child_org_id', '=', context.orgId)
      .executeTakeFirst();
    if (!relationship) throw federationNotFound('Relationship not found');
    if (relationship.status !== 'active')
      throw federationUnprocessable(
        'Contributions require an active relationship',
      );
    const space = await trx
      .selectFrom('spaces')
      .select(['id'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.spaceId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!space) throw federationNotFound('Space not found');
    let created = 0;
    for (const window of input.windows) {
      const startsAt = new Date(window.startsAt);
      const endsAt = new Date(window.endsAt);
      if (!(startsAt.getTime() < endsAt.getTime()))
        throw new RangeError('Window end must follow start');
      const conflict = await sql<{ id: string }>`
        WITH RECURSIVE descendants AS (
          SELECT id FROM spaces WHERE org_id = ${context.orgId} AND id = ${input.spaceId}::uuid
          UNION ALL
          SELECT child.id FROM spaces child
          JOIN descendants parent ON child.parent_space_id = parent.id
          WHERE child.org_id = ${context.orgId}
        )
        SELECT b.id FROM space_bookings b
        WHERE b.org_id = ${context.orgId}
          AND b.leaf_space_id IN (SELECT id FROM descendants)
          AND b.during && tstzrange(${window.startsAt}::timestamptz, ${window.endsAt}::timestamptz, '[)')
        LIMIT 1
      `.execute(trx);
      if (conflict.rows.length)
        throw federationUnprocessable(
          `Window ${window.startsAt} overlaps an existing booking`,
        );
      await trx
        .insertInto('federation_space_contributions')
        .values({
          id: newId(),
          org_id: context.orgId,
          relationship_id: relationship.id,
          space_id: input.spaceId,
          starts_at: startsAt,
          ends_at: endsAt,
          status: 'offered',
          notes: input.notes ?? null,
          created_by: context.actor.accountId,
        })
        .execute();
      created += 1;
    }
    await appendAuditEvent(trx, context, {
      action: 'federation.space_contributions.offered',
      entityType: 'org_relationship',
      entityId: relationship.id,
      changes: {
        spaceId: { tier: 'internal', after: input.spaceId },
        windows: { tier: 'internal', after: created },
      },
    });
    return { created };
  });
}

/** Club lists its own offered windows. */
export async function listClubContributions(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<ContributionWindow[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const rows = await trx
      .selectFrom('federation_space_contributions as c')
      .innerJoin('spaces', (join) =>
        join
          .onRef('spaces.org_id', '=', 'c.org_id')
          .onRef('spaces.id', '=', 'c.space_id'),
      )
      .leftJoin('facilities', (join) =>
        join
          .onRef('facilities.org_id', '=', 'spaces.org_id')
          .onRef('facilities.id', '=', 'spaces.facility_id'),
      )
      .select([
        'c.id',
        'c.relationship_id',
        'c.space_id',
        'spaces.name as space_name',
        'facilities.name as facility_name',
        'c.starts_at',
        'c.ends_at',
        'c.status',
        'c.notes',
      ])
      .orderBy('c.starts_at')
      .limit(1000)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      relationshipId: row.relationship_id,
      spaceId: row.space_id,
      spaceName: row.space_name,
      facilityName: row.facility_name ?? 'Facility',
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      status: row.status,
      notes: row.notes,
    }));
  });
}

/** Club withdraws a contributed window that has no scheduled games. */
export async function withdrawContribution(
  database: Kysely<DB>,
  context: OrgContext,
  contributionId: string,
): Promise<{ id: string }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const row = await trx
      .selectFrom('federation_space_contributions')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', contributionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw federationNotFound('Contribution not found');
    if (row.status !== 'offered')
      throw federationUnprocessable('Window already withdrawn');
    const used = await sql<{ id: string }>`
      SELECT l.id FROM federation_event_links l
      WHERE l.club_org_id = ${context.orgId}
        AND l.status = 'active'
        AND ${row.space_id}::uuid = ANY(l.leaf_space_ids)
      LIMIT 1
    `.execute(trx);
    if (used.rows.length)
      throw federationUnprocessable(
        'This space hosts scheduled games; ask the league to move them first',
      );
    await trx
      .updateTable('federation_space_contributions')
      .set({ status: 'withdrawn', version: row.version + 1 })
      .where('id', '=', row.id)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'federation.space_contribution.withdrawn',
      entityType: 'federation_space_contribution',
      entityId: row.id,
      changes: {
        startsAt: { tier: 'internal', after: row.starts_at.toISOString() },
      },
    });
    return { id: row.id };
  });
}

function bookingWindows(
  during: string,
): { startsAt: string; endsAt: string } | null {
  const match = /^[[(](.*),(.*)[)\]]$/.exec(during);
  if (!match?.[1] || !match[2]) return null;
  return {
    startsAt: new Date(match[1]).toISOString(),
    endsAt: new Date(match[2]).toISOString(),
  };
}

/**
 * Privileged read for the league scheduler: league-owned availability plus all
 * offered member-club windows and each host space's existing bookings (so the
 * generator avoids them). Each club whose data is read is audited.
 */
export async function readProgramAvailability(
  context: OrgContext,
  programId: string,
): Promise<{ spaces: FederationSpace[]; timezone: string }> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.org_id', ${context.orgId}, true)`.execute(
      trx,
    );
    await sql`SELECT set_config('app.actor_id', ${context.actor.accountId}, true)`.execute(
      trx,
    );
    const program = await trx
      .selectFrom('programs')
      .select(['id', 'starts_on', 'ends_on'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', programId)
      .executeTakeFirst();
    if (!program) throw federationNotFound('Program not found');
    const leagueOrg = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', context.orgId)
      .executeTakeFirstOrThrow();
    const timezone = leagueOrg.timezone;

    const spaces = new Map<string, FederationSpace>();
    const leagueAvailability = await trx
      .selectFrom('space_availability')
      .innerJoin('spaces', (join) =>
        join
          .onRef('spaces.org_id', '=', 'space_availability.org_id')
          .onRef('spaces.id', '=', 'space_availability.space_id'),
      )
      .select([
        'spaces.id',
        'spaces.facility_id',
        'spaces.name',
        'space_availability.recurrence',
        'space_availability.starts_on',
        'space_availability.ends_on',
        'space_availability.start_time',
        'space_availability.end_time',
      ])
      .where('spaces.org_id', '=', context.orgId)
      .where('spaces.archived_at', 'is', null)
      .execute();
    for (const row of leagueAvailability) {
      const space = spaces.get(row.id) ?? {
        id: row.id,
        ownerOrgId: context.orgId,
        facilityId: row.facility_id,
        name: row.name,
        availability: [],
        bookings: [],
      };
      space.availability.push(
        ...expandAvailabilityWindows({
          recurrence: row.recurrence,
          startsOn: new Date(row.starts_on).toISOString().slice(0, 10),
          endsOn: new Date(row.ends_on).toISOString().slice(0, 10),
          startTime: row.start_time,
          endTime: row.end_time,
          timezone,
        }),
      );
      spaces.set(row.id, space);
    }
    const leagueBookings = await trx
      .selectFrom('space_bookings')
      .select(['leaf_space_id', 'during'])
      .where('org_id', '=', context.orgId)
      .execute();
    for (const booking of leagueBookings) {
      const space = spaces.get(booking.leaf_space_id);
      const window = bookingWindows(booking.during);
      if (space && window) space.bookings.push(window);
    }
    const leagueBlackouts = await trx
      .selectFrom('space_blackouts')
      .select(['space_id', 'facility_id', 'starts_at', 'ends_at'])
      .where('org_id', '=', context.orgId)
      .execute();
    const leagueSpaceFacility = new Map(
      [...spaces.values()].map((space) => [space.id, space.facilityId]),
    );
    for (const blackout of leagueBlackouts) {
      for (const space of spaces.values()) {
        if (
          (blackout.space_id && space.id === blackout.space_id) ||
          (blackout.facility_id &&
            leagueSpaceFacility.get(space.id) === blackout.facility_id)
        )
          space.bookings.push({
            startsAt: new Date(blackout.starts_at).toISOString(),
            endsAt: new Date(blackout.ends_at).toISOString(),
          });
      }
    }

    const contributions = await trx
      .selectFrom('federation_space_contributions as c')
      .innerJoin('org_relationships as r', 'r.id', 'c.relationship_id')
      .innerJoin('spaces', (join) =>
        join
          .onRef('spaces.org_id', '=', 'c.org_id')
          .onRef('spaces.id', '=', 'c.space_id'),
      )
      .select([
        'c.id',
        'c.org_id as club_org_id',
        'c.space_id',
        'spaces.facility_id',
        'spaces.name',
        'c.starts_at',
        'c.ends_at',
      ])
      .where('r.parent_org_id', '=', context.orgId)
      .where('r.status', '=', 'active')
      .where('c.status', '=', 'offered')
      .where('c.ends_at', '>=', new Date(program.starts_on))
      .where('c.starts_at', '<=', new Date(program.ends_on))
      .execute();
    const clubIds = [...new Set(contributions.map((row) => row.club_org_id))];
    for (const clubId of clubIds) {
      const clubBookings = await trx
        .selectFrom('space_bookings')
        .select(['leaf_space_id', 'during'])
        .where('org_id', '=', clubId)
        .execute();
      for (const booking of clubBookings) {
        const key = `${clubId}:${booking.leaf_space_id}`;
        const space = spaces.get(key) ?? spaces.get(booking.leaf_space_id);
        const window = bookingWindows(booking.during);
        if (space && window) space.bookings.push(window);
      }
      await appendAuditEvent(
        trx,
        { orgId: clubId, actor: context.actor },
        {
          action: 'federation.cross_org.read',
          entityType: 'space_availability',
          entityId: clubId,
          changes: {
            dataset: { tier: 'internal', after: 'space_contributions' },
            requestingOrgId: { tier: 'internal', after: context.orgId },
          },
        },
      );
    }
    for (const row of contributions) {
      const space = spaces.get(row.space_id) ?? {
        id: row.space_id,
        ownerOrgId: row.club_org_id,
        facilityId: row.facility_id,
        name: row.name,
        availability: [],
        bookings: [],
      };
      space.availability.push({
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
      });
      spaces.set(row.space_id, space);
    }
    await appendAuditEvent(trx, context, {
      action: 'federation.cross_org.read',
      entityType: 'program',
      entityId: programId,
      changes: {
        dataset: { tier: 'internal', after: 'space_contributions' },
        memberOrgIds: { tier: 'internal', after: clubIds },
      },
    });
    return { spaces: [...spaces.values()], timezone };
  });
}
