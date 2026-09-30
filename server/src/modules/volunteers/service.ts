import { Temporal } from '@js-temporal/polyfill';
import { ageOnDate, orgToday } from '@shared/dates';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';
import { assertEligibleForRole } from '../compliance/policy';
import { PostgresInvoiceRepository } from '../finance/invoice-repo';

export class VolunteerConflictError extends Error {
  readonly status = 409;
  readonly code = 'CONFLICT';
}

class VolunteerNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}

export class VolunteerAccessError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
}

function numericValue(value: number | string): number {
  return Number(value);
}

const dateOnly = (value: Date | string): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);

export async function createVolunteerRole(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    name: string;
    description?: string | null | undefined;
    minimumAge: number;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const row = await trx
      .insertInto('volunteer_roles')
      .values({
        org_id: context.orgId,
        name: input.name,
        description: input.description ?? null,
        minimum_age: input.minimumAge,
        created_by: context.actor.accountId,
      })
      .returning([
        'id',
        'name',
        'description',
        'minimum_age',
        'archived_at',
        'version',
      ])
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'volunteer_role.created',
      entityType: 'volunteer_role',
      entityId: row.id,
      changes: { name: { tier: 'internal', after: row.name } },
    });
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      minimumAge: row.minimum_age,
      archivedAt: row.archived_at?.toISOString() ?? null,
      version: row.version,
    };
  });
}

export async function listVolunteerRoles(
  context: OrgContext,
  database: Kysely<DB>,
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('volunteer_roles')
      .select([
        'id',
        'name',
        'description',
        'minimum_age',
        'archived_at',
        'version',
      ])
      .where('org_id', '=', context.orgId)
      .where('archived_at', 'is', null)
      .orderBy('name')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      minimumAge: row.minimum_age,
      archivedAt: row.archived_at?.toISOString() ?? null,
      version: row.version,
    }));
  });
}

export async function createVolunteerRequirement(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    seasonId?: string | null | undefined;
    programId?: string | null | undefined;
    unit: 'hours' | 'shifts';
    amountPerHousehold?: number | null | undefined;
    amountPerAthlete?: number | null | undefined;
    buyoutPriceCents?: number | null | undefined;
    buyoutOfferingId?: string | null | undefined;
    deadline: string;
    autoInvoiceShortfall: boolean;
    noticeDays: number;
    countsCoachRoles: boolean;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const row = await trx
      .insertInto('volunteer_requirements')
      .values({
        org_id: context.orgId,
        season_id: input.seasonId ?? null,
        program_id: input.programId ?? null,
        unit: input.unit,
        amount_per_household: input.amountPerHousehold ?? null,
        amount_per_athlete: input.amountPerAthlete ?? null,
        buyout_price_cents: input.buyoutPriceCents ?? null,
        buyout_offering_id: input.buyoutOfferingId ?? null,
        deadline: input.deadline,
        auto_invoice_shortfall: input.autoInvoiceShortfall,
        notice_days: input.noticeDays,
        counts_coach_roles: input.countsCoachRoles,
        created_by: context.actor.accountId,
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'volunteer_requirement.created',
      entityType: 'volunteer_requirement',
      entityId: row.id,
      changes: {
        unit: { tier: 'internal', after: input.unit },
        deadline: { tier: 'internal', after: input.deadline },
      },
    });
    return { id: row.id, version: row.version };
  });
}

export async function createVolunteerShift(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    requirementId?: string | null | undefined;
    volunteerRoleId: string;
    eventId?: string | null | undefined;
    facilityId: string;
    startsAt: string;
    endsAt: string;
    slots: number;
    creditHours: number;
    notes?: string | null | undefined;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const row = await trx
      .insertInto('volunteer_shifts')
      .values({
        org_id: context.orgId,
        requirement_id: input.requirementId ?? null,
        volunteer_role_id: input.volunteerRoleId,
        event_id: input.eventId ?? null,
        facility_id: input.facilityId,
        starts_at: new Date(input.startsAt),
        ends_at: new Date(input.endsAt),
        slots: input.slots,
        credit_hours: input.creditHours,
        notes: input.notes ?? null,
        created_by: context.actor.accountId,
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'volunteer_shift.created',
      entityType: 'volunteer_shift',
      entityId: row.id,
      changes: {
        slots: { tier: 'internal', after: input.slots },
        startsAt: { tier: 'internal', after: input.startsAt },
      },
    });
    return { id: row.id, version: row.version };
  });
}

export async function listVolunteerShifts(
  context: OrgContext,
  database: Kysely<DB>,
  range: { from?: string | undefined; to?: string | undefined } = {},
) {
  return createWithOrg(database)(context, async (trx) => {
    let query = trx
      .selectFrom('volunteer_shifts as shift')
      .innerJoin('volunteer_roles as role', (join) =>
        join
          .onRef('role.org_id', '=', 'shift.org_id')
          .onRef('role.id', '=', 'shift.volunteer_role_id'),
      )
      .select([
        'shift.id',
        'shift.requirement_id',
        'shift.volunteer_role_id',
        'role.name as role_name',
        'shift.event_id',
        'shift.facility_id',
        'shift.starts_at',
        'shift.ends_at',
        'shift.slots',
        'shift.credit_hours',
        'shift.notes',
        'shift.status',
        'shift.version',
      ])
      .select((eb) =>
        eb
          .selectFrom('volunteer_signups as signup')
          .select((sub) => sub.fn.countAll<number>().as('filled'))
          .whereRef('signup.org_id', '=', 'shift.org_id')
          .whereRef('signup.volunteer_shift_id', '=', 'shift.id')
          .where('signup.status', 'in', [
            'signed_up',
            'confirmed',
            'checked_in',
            'completed',
          ])
          .as('filled_slots'),
      )
      .where('shift.org_id', '=', context.orgId);
    if (range.from)
      query = query.where('shift.starts_at', '>=', new Date(range.from));
    if (range.to)
      query = query.where('shift.starts_at', '<', new Date(range.to));
    const rows = await query.orderBy('shift.starts_at').execute();
    return rows.map((row) => ({
      id: row.id,
      requirementId: row.requirement_id,
      volunteerRoleId: row.volunteer_role_id,
      roleName: row.role_name,
      eventId: row.event_id,
      facilityId: row.facility_id,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      slots: row.slots,
      filledSlots: row.filled_slots,
      creditHours: numericValue(row.credit_hours),
      notes: row.notes,
      status: row.status,
      version: row.version,
    }));
  });
}

export async function signupForVolunteerShift(
  database: Kysely<DB>,
  context: OrgContext,
  input: { shiftId: string; personId: string; householdId: string },
  now = new Date(),
) {
  const scoped = createWithOrg(database);
  await scoped(context, async (trx) => {
    const row = await trx
      .selectFrom('volunteer_shifts as shift')
      .innerJoin('volunteer_roles as role', (join) =>
        join
          .onRef('role.org_id', '=', 'shift.org_id')
          .onRef('role.id', '=', 'shift.volunteer_role_id'),
      )
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'shift.org_id')
          .on('person.id', '=', input.personId),
      )
      .innerJoin('organizations as org', 'org.id', 'shift.org_id')
      .select([
        'shift.id',
        'shift.status as shift_status',
        'shift.starts_at',
        'role.minimum_age',
        'person.date_of_birth',
        'org.timezone',
      ])
      .where('shift.org_id', '=', context.orgId)
      .where('shift.id', '=', input.shiftId)
      .where('role.archived_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new VolunteerNotFoundError('Shift not found');
    if (row.shift_status !== 'open' || row.starts_at <= now)
      throw new VolunteerConflictError('Shift signups are closed');
    const link = await trx
      .selectFrom('household_members as member')
      .innerJoin('person_account_links as link', (join) =>
        join
          .onRef('link.org_id', '=', 'member.org_id')
          .onRef('link.person_id', '=', 'member.person_id'),
      )
      .select('link.relationship')
      .where('member.org_id', '=', context.orgId)
      .where('member.household_id', '=', input.householdId)
      .where('member.person_id', '=', input.personId)
      .where('member.removed_at', 'is', null)
      .where('link.account_id', '=', context.actor.accountId)
      .where('link.revoked_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb('link.relationship', '=', 'guardian'),
            eb('link.verified_at', 'is not', null),
          ]),
          eb('link.relationship', '=', 'self'),
        ]),
      )
      .executeTakeFirst();
    if (!link)
      throw new VolunteerAccessError('Household relationship required');
    const localToday = orgToday(
      row.timezone,
      Temporal.Instant.fromEpochMilliseconds(now.getTime()),
    );
    const localAge = ageOnDate(dateOnly(row.date_of_birth), localToday);
    if (localAge < row.minimum_age)
      throw new VolunteerAccessError('Volunteer role minimum age is not met');
    return { minimumAge: row.minimum_age };
  });
  // Phase 7 owns the shared compliance policy; a volunteer is never booked around its credential gate.
  await assertEligibleForRole(
    database,
    context,
    { personId: input.personId, role: 'volunteer' },
    now,
  );
  return scoped(context, async (trx) => {
    const shift = await trx
      .selectFrom('volunteer_shifts')
      .select(['id', 'slots', 'status', 'starts_at'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.shiftId)
      .forUpdate()
      .executeTakeFirst();
    if (!shift) throw new VolunteerNotFoundError('Shift not found');
    if (shift.status !== 'open' || shift.starts_at <= now)
      throw new VolunteerConflictError('Shift signups are closed');
    const filled = await trx
      .selectFrom('volunteer_signups')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('org_id', '=', context.orgId)
      .where('volunteer_shift_id', '=', input.shiftId)
      .where('status', 'in', [
        'signed_up',
        'confirmed',
        'checked_in',
        'completed',
      ])
      .executeTakeFirstOrThrow();
    if (filled.count >= shift.slots)
      throw new VolunteerConflictError('Shift is full');
    const row = await trx
      .insertInto('volunteer_signups')
      .values({
        org_id: context.orgId,
        volunteer_shift_id: input.shiftId,
        person_id: input.personId,
        household_id: input.householdId,
        created_by: context.actor.accountId,
      })
      .returning(['id', 'status', 'hours_credited', 'version'])
      .executeTakeFirst();
    if (!row)
      throw new VolunteerConflictError(
        'Person is already signed up for this shift',
      );
    await appendAuditEvent(trx, context, {
      action: 'volunteer_signup.created',
      entityType: 'volunteer_signup',
      entityId: row.id,
      changes: { shiftId: { tier: 'internal', after: input.shiftId } },
    });
    return {
      id: row.id,
      volunteerShiftId: input.shiftId,
      personId: input.personId,
      householdId: input.householdId,
      status: row.status,
      hoursCredited: numericValue(row.hours_credited),
      version: row.version,
    };
  });
}

export async function updateVolunteerSignup(
  database: Kysely<DB>,
  context: OrgContext,
  signupId: string,
  input: {
    status: 'confirmed' | 'checked_in' | 'completed' | 'no_show' | 'canceled';
    hoursCredited?: number | undefined;
    expectedVersion: number;
  },
  now = new Date(),
) {
  return createWithOrg(database)(context, async (trx) => {
    const current = await trx
      .selectFrom('volunteer_signups as signup')
      .innerJoin('volunteer_shifts as shift', (join) =>
        join
          .onRef('shift.org_id', '=', 'signup.org_id')
          .onRef('shift.id', '=', 'signup.volunteer_shift_id'),
      )
      .select([
        'signup.id',
        'signup.status',
        'signup.version',
        'signup.hours_credited',
        'shift.credit_hours',
      ])
      .where('signup.org_id', '=', context.orgId)
      .where('signup.id', '=', signupId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new VolunteerNotFoundError('Signup not found');
    if (current.version !== input.expectedVersion)
      throw new VolunteerConflictError(
        'Signup changed; reload before updating',
      );
    const transitions: Record<string, string[]> = {
      signed_up: ['confirmed', 'checked_in', 'no_show', 'canceled'],
      confirmed: ['checked_in', 'no_show', 'canceled'],
      checked_in: ['completed', 'no_show'],
      completed: [],
      no_show: [],
      canceled: [],
    };
    if (!transitions[current.status]?.includes(input.status))
      throw new VolunteerConflictError('This signup status cannot be changed');
    const hours =
      input.status === 'completed'
        ? (input.hoursCredited ?? numericValue(current.credit_hours))
        : 0;
    if (
      input.status === 'completed' &&
      (!Number.isFinite(hours) ||
        hours < 0 ||
        hours > numericValue(current.credit_hours))
    )
      throw new VolunteerConflictError(
        'Credited hours must be within the shift credit limit',
      );
    const row = await trx
      .updateTable('volunteer_signups')
      .set({
        status: input.status,
        hours_credited: hours,
        credited_by:
          input.status === 'completed' ? context.actor.accountId : null,
        credited_at: input.status === 'completed' ? now : null,
        version: sql`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', signupId)
      .where('version', '=', input.expectedVersion)
      .returning([
        'id',
        'volunteer_shift_id',
        'person_id',
        'household_id',
        'status',
        'hours_credited',
        'version',
      ])
      .executeTakeFirst();
    if (!row)
      throw new VolunteerConflictError(
        'Signup changed; reload before updating',
      );
    await appendAuditEvent(trx, context, {
      action: `volunteer_signup.${input.status}`,
      entityType: 'volunteer_signup',
      entityId: row.id,
      changes: {
        status: { tier: 'internal', before: current.status, after: row.status },
        ...(input.status === 'completed'
          ? { hoursCredited: { tier: 'internal' as const, after: hours } }
          : {}),
      },
    });
    return {
      id: row.id,
      volunteerShiftId: row.volunteer_shift_id,
      personId: row.person_id,
      householdId: row.household_id,
      status: row.status,
      hoursCredited: numericValue(row.hours_credited),
      version: row.version,
    };
  });
}

interface RequirementRow {
  requirement_id: string;
  scope_id: string;
  scope_name: string;
  unit: 'hours' | 'shifts';
  household_amount: string | number | null;
  athlete_amount: string | number | null;
  person_id: string;
  deadline: Date | string;
  buyout_price_cents: number | null;
  timezone: string;
}

export async function listVolunteerRequirements(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, async (trx) => {
    const result = await sql<{
      id: string;
      season_id: string | null;
      program_id: string | null;
      scope_name: string;
      unit: 'hours' | 'shifts';
      amount_per_household: string | number | null;
      amount_per_athlete: string | number | null;
      buyout_price_cents: number | null;
      deadline: Date | string;
      auto_invoice_shortfall: boolean;
      notice_days: number;
      counts_coach_roles: boolean;
      version: number;
    }>`
      SELECT req.id, req.season_id, req.program_id,
        COALESCE(program.name, season.name) AS scope_name,
        req.unit, req.amount_per_household, req.amount_per_athlete,
        req.buyout_price_cents, req.deadline, req.auto_invoice_shortfall,
        req.notice_days, req.counts_coach_roles, req.version
      FROM volunteer_requirements req
      LEFT JOIN programs program
        ON program.org_id = req.org_id AND program.id = req.program_id
      LEFT JOIN seasons season
        ON season.org_id = req.org_id AND season.id = req.season_id
      WHERE req.org_id = ${context.orgId}::uuid
      ORDER BY req.deadline, scope_name
    `.execute(trx);
    return result.rows.map((row) => ({
      id: row.id,
      seasonId: row.season_id,
      programId: row.program_id,
      scopeName: row.scope_name,
      unit: row.unit,
      amountPerHousehold:
        row.amount_per_household === null
          ? null
          : Number(row.amount_per_household),
      amountPerAthlete:
        row.amount_per_athlete === null ? null : Number(row.amount_per_athlete),
      buyoutPriceCents: row.buyout_price_cents,
      deadline: dateOnly(row.deadline),
      autoInvoiceShortfall: row.auto_invoice_shortfall,
      noticeDays: row.notice_days,
      countsCoachRoles: row.counts_coach_roles,
      version: row.version,
    }));
  });
}

export async function listMyVolunteerHouseholds(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('household_members as member')
      .innerJoin('person_account_links as link', (join) =>
        join
          .onRef('link.org_id', '=', 'member.org_id')
          .onRef('link.person_id', '=', 'member.person_id'),
      )
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'member.org_id')
          .onRef('person.id', '=', 'member.person_id'),
      )
      .select([
        'member.household_id',
        'member.person_id',
        'person.first_name',
        'person.last_name',
      ])
      .where('member.org_id', '=', context.orgId)
      .where('member.removed_at', 'is', null)
      .where('link.account_id', '=', context.actor.accountId)
      .where('link.verified_at', 'is not', null)
      .where('link.revoked_at', 'is', null)
      .execute();
    const households = new Map<
      string,
      { personIds: string[]; people: { id: string; name: string }[] }
    >();
    for (const row of rows) {
      const members = households.get(row.household_id) ?? {
        personIds: [],
        people: [],
      };
      members.personIds.push(row.person_id);
      members.people.push({
        id: row.person_id,
        name: `${row.first_name} ${row.last_name}`.trim(),
      });
      households.set(row.household_id, members);
    }
    return [...households.entries()].map(([id, members]) => ({
      id,
      personIds: members.personIds,
      people: members.people,
    }));
  });
}

export async function listShiftSignups(
  database: Kysely<DB>,
  context: OrgContext,
  shiftId: string,
) {
  return createWithOrg(database)(context, async (trx) => {
    const shift = await trx
      .selectFrom('volunteer_shifts')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', shiftId)
      .executeTakeFirst();
    if (!shift) throw new VolunteerNotFoundError('Shift not found');
    const rows = await trx
      .selectFrom('volunteer_signups as signup')
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'signup.org_id')
          .onRef('person.id', '=', 'signup.person_id'),
      )
      .select([
        'signup.id',
        'signup.volunteer_shift_id',
        'signup.person_id',
        'signup.household_id',
        'signup.status',
        sql<number>`signup.hours_credited::double precision`.as(
          'hours_credited',
        ),
        'signup.version',
        'person.first_name',
        'person.last_name',
      ])
      .where('signup.org_id', '=', context.orgId)
      .where('signup.volunteer_shift_id', '=', shiftId)
      .orderBy('person.last_name')
      .orderBy('person.first_name')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      volunteerShiftId: row.volunteer_shift_id,
      personId: row.person_id,
      householdId: row.household_id,
      personName: `${row.first_name} ${row.last_name}`.trim(),
      status: row.status,
      hoursCredited: numericValue(row.hours_credited),
      version: row.version,
    }));
  });
}

export async function householdVolunteerLedger(
  database: Kysely<DB>,
  context: OrgContext,
  householdId: string,
  now = new Date(),
) {
  return createWithOrg(database)(context, async (trx) => {
    const access = await trx
      .selectFrom('households as household')
      .select('household.id')
      .where('household.org_id', '=', context.orgId)
      .where('household.id', '=', householdId)
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('org_memberships')
              .select('id')
              .whereRef('org_memberships.org_id', '=', 'household.org_id')
              .where('org_memberships.account_id', '=', context.actor.accountId)
              .where('org_memberships.status', '=', 'active'),
          ),
          eb.exists(
            eb
              .selectFrom('household_members as member')
              .innerJoin('person_account_links as link', (join) =>
                join
                  .onRef('link.org_id', '=', 'member.org_id')
                  .onRef('link.person_id', '=', 'member.person_id'),
              )
              .select('link.id')
              .whereRef('member.org_id', '=', 'household.org_id')
              .whereRef('member.household_id', '=', 'household.id')
              .where('member.removed_at', 'is', null)
              .where('link.account_id', '=', context.actor.accountId)
              .where('link.relationship', '=', 'guardian')
              .where('link.verified_at', 'is not', null)
              .where('link.revoked_at', 'is', null),
          ),
        ]),
      )
      .executeTakeFirst();
    if (!access) throw new VolunteerNotFoundError('Household not found');
    const requirements = await sql<RequirementRow>`
      SELECT DISTINCT req.id AS requirement_id,
        COALESCE(req.program_id, req.season_id) AS scope_id,
        COALESCE(program.name, season.name) AS scope_name,
        req.unit, req.amount_per_household AS household_amount,
        req.amount_per_athlete AS athlete_amount, member.person_id,
        req.deadline, req.buyout_price_cents, org.timezone
      FROM volunteer_requirements req
      JOIN registrations registration
        ON registration.org_id = req.org_id
       AND registration.status = 'confirmed'
      JOIN programs program
        ON program.org_id = registration.org_id
       AND program.id = registration.program_id
      JOIN seasons season
        ON season.org_id = program.org_id
       AND season.id = program.season_id
      JOIN household_members member
        ON member.org_id = registration.org_id
       AND member.household_id = registration.household_id
       AND member.person_id = registration.person_id
       AND member.removed_at IS NULL
      JOIN organizations org ON org.id = req.org_id
      WHERE req.org_id = ${context.orgId}::uuid
        AND registration.household_id = ${householdId}::uuid
        AND ((req.program_id IS NOT NULL AND req.program_id = program.id)
          OR (req.season_id IS NOT NULL AND req.season_id = season.id))
      ORDER BY req.id, member.person_id
    `.execute(trx);
    const reqRows = requirements.rows;
    const requirementIds = [
      ...new Set(reqRows.map((row) => row.requirement_id)),
    ];
    if (!requirementIds.length) return { householdId, items: [] };
    const credits = await sql<{
      requirement_id: string;
      person_id: string | null;
      completed: string | number;
    }>`
      SELECT requirement.id AS requirement_id,
        CASE WHEN requirement.amount_per_athlete IS NOT NULL THEN signup.person_id ELSE NULL END AS person_id,
        COALESCE(sum(CASE WHEN signup.status = 'completed' THEN
          CASE WHEN requirement.unit = 'hours' THEN signup.hours_credited ELSE 1 END
          ELSE 0 END), 0) AS completed
      FROM volunteer_signups signup
      JOIN volunteer_shifts shift
        ON shift.org_id = signup.org_id AND shift.id = signup.volunteer_shift_id
      JOIN volunteer_requirements requirement
        ON requirement.org_id = shift.org_id AND requirement.id = shift.requirement_id
      WHERE signup.org_id = ${context.orgId}::uuid
        AND signup.household_id = ${householdId}::uuid
        AND requirement.id = ANY(${requirementIds}::uuid[])
      GROUP BY requirement.id, signup.org_id, signup.household_id,
        CASE WHEN requirement.amount_per_athlete IS NOT NULL THEN signup.person_id ELSE NULL END
    `.execute(trx);
    const creditMap = new Map(
      credits.rows.map((row) => [
        `${row.requirement_id}:${row.person_id ?? 'household'}`,
        { completed: Number(row.completed), boughtOut: 0 },
      ]),
    );
    const buyouts = await sql<{
      requirement_id: string;
      person_id: string | null;
      units: string | number;
    }>`
      SELECT requirement_id, person_id, sum(units) AS units
      FROM volunteer_buyouts
      WHERE org_id = ${context.orgId}::uuid
        AND household_id = ${householdId}::uuid
        AND requirement_id = ANY(${requirementIds}::uuid[])
      GROUP BY requirement_id, person_id
    `.execute(trx);
    for (const row of buyouts.rows) {
      const key = `${row.requirement_id}:${row.person_id ?? 'household'}`;
      const current = creditMap.get(key);
      creditMap.set(key, {
        completed: current?.completed ?? 0,
        boughtOut: Number(row.units),
      });
    }
    const rowsByRequirement = new Map<string, RequirementRow[]>();
    for (const row of reqRows) {
      const rows = rowsByRequirement.get(row.requirement_id) ?? [];
      rows.push(row);
      rowsByRequirement.set(row.requirement_id, rows);
    }
    const items = [...rowsByRequirement.entries()].flatMap(([id, rows]) => {
      const first = rows[0];
      if (!first) return [];
      const today = orgToday(
        first.timezone,
        Temporal.Instant.fromEpochMilliseconds(now.getTime()),
      );
      const deadline = dateOnly(first.deadline);
      const targetPersonIds =
        first.athlete_amount === null
          ? [null]
          : [...new Map(rows.map((row) => [row.person_id, row])).values()].map(
              (row) => row.person_id,
            );
      return targetPersonIds.map((personId) => {
        const required = Number(
          first.household_amount ?? first.athlete_amount ?? 0,
        );
        const perPerson = personId
          ? (creditMap.get(`${id}:${personId}`) ?? {
              completed: 0,
              boughtOut: 0,
            })
          : null;
        const allCredits = personId
          ? perPerson
          : (creditMap.get(`${id}:household`) ?? {
              completed: 0,
              boughtOut: 0,
            });
        const completed = allCredits?.completed ?? 0;
        const boughtOut = allCredits?.boughtOut ?? 0;
        const remaining = Math.max(0, required - completed - boughtOut);
        const price = first.buyout_price_cents;
        return {
          requirementId: id,
          scopeId: first.scope_id,
          scopeName: first.scope_name,
          unit: first.unit,
          subjectPersonId: personId,
          required,
          completed,
          boughtOut,
          remaining,
          deadline,
          buyoutPriceCents: price,
          buyoutAvailable:
            price !== null && price > 0 && deadline >= today && remaining > 0,
        };
      });
    });
    return { householdId, items };
  });
}

export async function buyOutVolunteerRequirement(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    householdId: string;
    personId?: string | null;
    requirementId: string;
    units: number;
    creationKey: string;
  },
  now = new Date(),
) {
  const lockKey = [
    'volunteer-buyout',
    context.orgId,
    input.requirementId,
    input.householdId,
    input.personId ?? 'household',
  ].join(':');
  return database.connection().execute(async (connection) => {
    await sql`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`.execute(
      connection,
    );
    try {
      return await issueVolunteerBuyout(database, context, input, now);
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.execute(
        connection,
      );
    }
  });
}

async function issueVolunteerBuyout(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    householdId: string;
    personId?: string | null | undefined;
    requirementId: string;
    units: number;
    creationKey: string;
  },
  now: Date,
) {
  const scoped = createWithOrg(database);
  const existing = await scoped(context, async (trx) =>
    trx
      .selectFrom('volunteer_buyouts')
      .select(['id', 'invoice_id', 'amount_cents', 'units'])
      .where('org_id', '=', context.orgId)
      .where('creation_key', '=', input.creationKey)
      .executeTakeFirst(),
  );
  if (existing)
    return {
      id: existing.id,
      invoiceId: existing.invoice_id,
      amountCents: existing.amount_cents,
      units: existing.units,
    };
  const ledger = await householdVolunteerLedger(
    database,
    context,
    input.householdId,
    now,
  );
  const item = ledger.items.find(
    (candidate) =>
      candidate.requirementId === input.requirementId &&
      candidate.subjectPersonId === (input.personId ?? null),
  );
  if (!item || !item.buyoutAvailable || item.buyoutPriceCents === null)
    throw new VolunteerConflictError('Volunteer buyout is unavailable');
  if (input.units > item.remaining)
    throw new VolunteerConflictError(
      'Buyout units exceed the remaining requirement',
    );
  const amountCents = Math.ceil(input.units * item.buyoutPriceCents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
    throw new RangeError('Buyout amount is outside the supported range');
  const requirement = await scoped(context, async (trx) => {
    const finance = await trx
      .selectFrom('household_members as member')
      .innerJoin('person_account_links as link', (join) =>
        join
          .onRef('link.org_id', '=', 'member.org_id')
          .onRef('link.person_id', '=', 'member.person_id'),
      )
      .select('member.id')
      .where('member.org_id', '=', context.orgId)
      .where('member.household_id', '=', input.householdId)
      .where('member.removed_at', 'is', null)
      .where('member.financially_responsible', '=', true)
      .where('link.account_id', '=', context.actor.accountId)
      .where('link.relationship', '=', 'guardian')
      .where('link.verified_at', 'is not', null)
      .where('link.revoked_at', 'is', null)
      .executeTakeFirst();
    if (!finance)
      throw new VolunteerAccessError(
        'Financially responsible guardian required',
      );
    return trx
      .selectFrom('volunteer_requirements')
      .innerJoin('households', (join) =>
        join
          .on('households.org_id', '=', context.orgId)
          .on('households.id', '=', input.householdId),
      )
      .select(['volunteer_requirements.id', 'volunteer_requirements.deadline'])
      .where('volunteer_requirements.org_id', '=', context.orgId)
      .where('volunteer_requirements.id', '=', input.requirementId)
      .executeTakeFirst();
  });
  if (!requirement) throw new VolunteerNotFoundError('Requirement not found');
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
    orgId: context.orgId,
    accountId: context.actor.accountId,
    householdId: input.householdId,
    source: 'staff',
    dueOn: dateOnly(requirement.deadline),
    creationKey: input.creationKey,
    memo: 'Volunteer requirement buyout',
    lines: [
      {
        kind: 'volunteer_buyout',
        description: `Volunteer requirement buyout (${String(input.units)} units)`,
        amountCents,
        refundable: false,
      },
    ],
  });
  const row = await scoped(context, async (trx) => {
    const current = await trx
      .selectFrom('volunteer_requirements')
      .select(['buyout_price_cents', 'deadline'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.requirementId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new VolunteerNotFoundError('Requirement not found');
    const currentLedger = await householdVolunteerLedger(
      database,
      context,
      input.householdId,
      now,
    );
    const latest = currentLedger.items.find(
      (candidate) =>
        candidate.requirementId === input.requirementId &&
        candidate.subjectPersonId === (input.personId ?? null),
    );
    if (!latest || input.units > latest.remaining)
      throw new VolunteerConflictError(
        'Requirement changed before buyout was recorded',
      );
    const buyout = await trx
      .insertInto('volunteer_buyouts')
      .values({
        org_id: context.orgId,
        requirement_id: input.requirementId,
        household_id: input.householdId,
        person_id: input.personId ?? null,
        units: input.units,
        amount_cents: amountCents,
        invoice_id: invoice.id,
        creation_key: input.creationKey,
        created_by: context.actor.accountId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'volunteer_requirement.buyout_issued',
      entityType: 'volunteer_buyout',
      entityId: buyout.id,
      changes: {
        units: { tier: 'internal', after: input.units },
        amountCents: { tier: 'internal', after: amountCents },
      },
    });
    return buyout;
  });
  return { id: row.id, invoiceId: invoice.id, amountCents, units: input.units };
}
