import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { requireVersion } from '../../lib/version-check';
import { appendAuditEvent } from '../audit/service';

import {
  federationConflict,
  federationNotFound,
  federationUnprocessable,
} from './errors';

export interface RefereeView {
  profileId: string;
  personId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  level: string | null;
  compliant: boolean;
  active: boolean;
  assignmentCount: number;
}

export async function listReferees(
  database: Kysely<DB>,
  context: OrgContext,
): Promise<RefereeView[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const rows = await trx
      .selectFrom('official_profiles')
      .innerJoin('people', (join) =>
        join
          .onRef('people.org_id', '=', 'official_profiles.org_id')
          .onRef('people.id', '=', 'official_profiles.person_id'),
      )
      .select([
        'official_profiles.id as profile_id',
        'official_profiles.person_id',
        'official_profiles.grade',
        'official_profiles.level',
        'official_profiles.active',
        'people.first_name',
        'people.last_name',
      ])
      .where('official_profiles.org_id', '=', context.orgId)
      .orderBy('people.last_name')
      .execute();
    const personIds = rows.map((row) => row.person_id);
    const credentials = personIds.length
      ? await trx
          .selectFrom('person_credentials')
          .select(['person_id', 'status', 'expires_on'])
          .where('org_id', '=', context.orgId)
          .where('person_id', 'in', personIds)
          .execute()
      : [];
    const today = new Date().toISOString().slice(0, 10);
    const compliant = new Set(
      personIds.filter((personId) =>
        credentials
          .filter((c) => c.person_id === personId)
          .some(
            (c) =>
              c.status === 'verified' &&
              (!c.expires_on ||
                new Date(c.expires_on).toISOString().slice(0, 10) >= today),
          ),
      ),
    );
    const assignments = personIds.length
      ? await trx
          .selectFrom('official_assignments')
          .select(['person_id'])
          .select((eb) => eb.fn.countAll().as('count'))
          .where('org_id', '=', context.orgId)
          .where('person_id', 'in', personIds)
          .where('status', 'not in', ['canceled', 'declined'])
          .groupBy('person_id')
          .execute()
      : [];
    const countByPerson = new Map(
      assignments.map((row) => [row.person_id, Number(row.count)]),
    );
    return rows.map((row) => ({
      profileId: row.profile_id,
      personId: row.person_id,
      firstName: row.first_name,
      lastName: row.last_name,
      grade: row.grade,
      level: row.level,
      compliant: compliant.has(row.person_id),
      active: row.active,
      assignmentCount: countByPerson.get(row.person_id) ?? 0,
    }));
  });
}

/** League adds a league-side person to the referee pool. */
export async function addReferee(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    personId: string;
    grade?: string | undefined;
    level?: string | undefined;
    sports?: string[] | undefined;
    maxGamesPerDay?: number | undefined;
    homeArea?: string | undefined;
  },
): Promise<RefereeView> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const person = await trx
      .selectFrom('people')
      .select(['id', 'first_name', 'last_name', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.personId)
      .executeTakeFirst();
    if (!person || person.status !== 'active')
      throw federationNotFound('Person not found');
    const existing = await trx
      .selectFrom('official_profiles')
      .select(['id', 'active'])
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', input.personId)
      .executeTakeFirst();
    let profileId: string;
    if (existing) {
      if (existing.active)
        throw federationConflict('Person is already in the referee pool');
      profileId = existing.id;
      await trx
        .updateTable('official_profiles')
        .set({ active: true })
        .where('id', '=', profileId)
        .execute();
    } else {
      profileId = newId();
      await trx
        .insertInto('official_profiles')
        .values({
          id: profileId,
          org_id: context.orgId,
          person_id: input.personId,
          grade: input.grade ?? null,
          level: input.level ?? null,
          sports: input.sports ?? [],
          max_games_per_day: input.maxGamesPerDay ?? null,
          home_area: input.homeArea ?? null,
          pay_rates: {},
          active: true,
        })
        .execute();
    }
    await appendAuditEvent(trx, context, {
      action: 'federation.referee.added',
      entityType: 'official_profile',
      entityId: profileId,
      changes: { personId: { tier: 'internal', after: input.personId } },
    });
    return {
      profileId,
      personId: input.personId,
      firstName: person.first_name,
      lastName: person.last_name,
      grade: input.grade ?? null,
      level: input.level ?? null,
      compliant: false,
      active: true,
      assignmentCount: 0,
    };
  });
}

export async function removeReferee(
  database: Kysely<DB>,
  context: OrgContext,
  profileId: string,
): Promise<{ id: string }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const profile = await trx
      .selectFrom('official_profiles')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', profileId)
      .forUpdate()
      .executeTakeFirst();
    if (!profile) throw federationNotFound('Referee not found');
    const future = await trx
      .selectFrom('official_assignments')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', profile.person_id)
      .where('status', 'in', ['offered', 'accepted', 'confirmed'])
      .executeTakeFirst();
    if (future)
      throw federationUnprocessable(
        'Cancel pending assignments before removing this referee',
      );
    await trx
      .updateTable('official_profiles')
      .set({ active: false, version: profile.version + 1 })
      .where('id', '=', profileId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'federation.referee.removed',
      entityType: 'official_profile',
      entityId: profileId,
      changes: { personId: { tier: 'internal', after: profile.person_id } },
    });
    return { id: profileId };
  });
}

/** League assigns a pool referee to one of its contests. */
export async function assignReferee(
  database: Kysely<DB>,
  context: OrgContext,
  contestId: string,
  input: {
    personId: string;
    positionKey: string;
    feeCents: number;
    mileageCents: number;
  },
): Promise<{ id: string; status: string }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const contest = await trx
      .selectFrom('contests')
      .select(['id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', contestId)
      .executeTakeFirst();
    if (!contest || ['final', 'canceled', 'forfeit'].includes(contest.status))
      throw federationNotFound('Contest not found');
    const profile = await trx
      .selectFrom('official_profiles')
      .select(['id', 'active'])
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', input.personId)
      .executeTakeFirst();
    if (!profile?.active)
      throw federationNotFound('Referee not found in the pool');
    const id = newId();
    await trx
      .insertInto('official_assignments')
      .values({
        id,
        org_id: context.orgId,
        contest_id: contestId,
        position_key: input.positionKey,
        person_id: input.personId,
        status: 'offered',
        fee_cents: input.feeCents,
        mileage_cents: input.mileageCents,
        assigned_by: context.actor.accountId,
      })
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'federation.referee.assigned',
      entityType: 'official_assignment',
      entityId: id,
      changes: {
        contestId: { tier: 'internal', after: contestId },
        personId: { tier: 'internal', after: input.personId },
        positionKey: { tier: 'internal', after: input.positionKey },
        feeCents: { tier: 'internal', after: input.feeCents },
      },
    });
    return { id, status: 'offered' };
  });
}

export async function updateAssignment(
  database: Kysely<DB>,
  context: OrgContext,
  assignmentId: string,
  input: { action: string; version?: number | undefined },
): Promise<{ id: string; status: string }> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const assignment = await trx
      .selectFrom('official_assignments')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', assignmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!assignment) throw federationNotFound('Assignment not found');
    if (input.version !== undefined) requireVersion(assignment, input.version);
    const next =
      input.action === 'accept'
        ? 'accepted'
        : input.action === 'decline'
          ? 'declined'
          : input.action === 'confirm'
            ? 'confirmed'
            : input.action === 'cancel'
              ? 'canceled'
              : 'no_show';
    const allowed: Record<string, string[]> = {
      offered: ['accepted', 'declined', 'canceled'],
      accepted: ['confirmed', 'canceled'],
      confirmed: ['canceled', 'no_show'],
      declined: ['offered'],
      canceled: [],
      no_show: [],
    };
    if (!(allowed[assignment.status] ?? []).includes(next))
      throw federationConflict(
        `Assignment cannot move from ${assignment.status} to ${next}`,
      );
    await trx
      .updateTable('official_assignments')
      .set({
        status: next,
        responded_at: ['accepted', 'declined'].includes(next)
          ? new Date()
          : assignment.responded_at,
        version: assignment.version + 1,
      })
      .where('id', '=', assignment.id)
      .execute();
    await appendAuditEvent(trx, context, {
      action: `federation.referee_assignment.${next}`,
      entityType: 'official_assignment',
      entityId: assignment.id,
      changes: {
        status: { tier: 'internal', before: assignment.status, after: next },
      },
    });
    return { id: assignment.id, status: next };
  });
}

export async function listAssignments(
  database: Kysely<DB>,
  context: OrgContext,
  contestId?: string,
): Promise<
  {
    id: string;
    contestId: string;
    personId: string;
    firstName: string;
    lastName: string;
    positionKey: string;
    status: string;
    feeCents: number;
    startsAt: string;
  }[]
> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    let query = trx
      .selectFrom('official_assignments as a')
      .innerJoin('people', (join) =>
        join
          .onRef('people.org_id', '=', 'a.org_id')
          .onRef('people.id', '=', 'a.person_id'),
      )
      .innerJoin('contests', (join) =>
        join
          .onRef('contests.org_id', '=', 'a.org_id')
          .onRef('contests.id', '=', 'a.contest_id'),
      )
      .innerJoin('events', (join) =>
        join
          .onRef('events.org_id', '=', 'contests.org_id')
          .onRef('events.id', '=', 'contests.event_id'),
      )
      .select([
        'a.id',
        'a.contest_id',
        'a.person_id',
        'a.position_key',
        'a.status',
        'a.fee_cents',
        'people.first_name',
        'people.last_name',
        'events.starts_at',
      ])
      .where('a.org_id', '=', context.orgId)
      .orderBy('events.starts_at')
      .limit(500);
    if (contestId) query = query.where('a.contest_id', '=', contestId);
    const rows = await query.execute();
    return rows.map((row) => ({
      id: row.id,
      contestId: row.contest_id,
      personId: row.person_id,
      firstName: row.first_name,
      lastName: row.last_name,
      positionKey: row.position_key,
      status: row.status,
      feeCents: row.fee_cents,
      startsAt: row.starts_at.toISOString(),
    }));
  });
}
