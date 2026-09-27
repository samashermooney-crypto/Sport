import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg';
import { requireStaff } from '../people/repo';

export const seasonCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
});
export const seasonUpdateSchema = seasonCreateSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
  status: z.enum(['planning', 'active', 'completed', 'archived']).optional(),
});
export const rolloverSchema = seasonCreateSchema.extend({
  offsetDays: z.number().int().min(-3660).max(3660).default(0),
  dateMap: z.record(z.iso.date(), z.iso.date()).default({}),
  returningTeamSeasonIds: z.array(z.uuid()),
  carryStaffIds: z.array(z.uuid()),
});
export class SeasonError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const pad2 = (value: number) => String(value).padStart(2, '0');
const dateOnly = (value: Date) =>
  [
    pad2(value.getFullYear()),
    pad2(value.getMonth() + 1),
    pad2(value.getDate()),
  ].join('-');
const day = (value: string) => value;
const shiftDate = (value: Date, offset: number) =>
  dateOnly(
    new Date(value.getFullYear(), value.getMonth(), value.getDate() + offset),
  );
const shiftInstant = (value: Date | null, offset: number) =>
  value ? new Date(value.getTime() + offset * 86_400_000) : null;

type DateMap = Readonly<Record<string, string>>;
const resolveDate = (value: Date, offset: number, map: DateMap) =>
  map[dateOnly(value)] ?? shiftDate(value, offset);
const resolveInstant = (
  value: Date | null,
  offset: number,
  map: DateMap,
  timeZone: string,
) => {
  if (!value) return null;
  const zoned = Temporal.Instant.fromEpochMilliseconds(
    value.getTime(),
  ).toZonedDateTimeISO(timeZone);
  const mapped = map[zoned.toPlainDate().toString()];
  if (!mapped) return shiftInstant(value, offset);
  const target = Temporal.PlainDateTime.from(
    `${mapped}T${zoned.toPlainTime().toString()}`,
  ).toZonedDateTime(timeZone, { disambiguation: 'compatible' });
  return new Date(target.toInstant().epochMilliseconds);
};

export type RolloverIdMap = {
  seasonId: string;
  programIds: ReadonlyMap<string, string>;
  divisionIds: ReadonlyMap<string, string>;
  teamSeasonIds: ReadonlyMap<string, string>;
  staffIds: ReadonlyMap<string, string>;
};
export type SeasonRolloverExtras = (
  trx: OrgTransaction,
  ids: RolloverIdMap,
) => Promise<void>;

export class SeasonsService {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly extras: SeasonRolloverExtras[] = [],
  ) {
    this.withOrg = createWithOrg(database);
  }
  private staff(trx: OrgTransaction) {
    return requireStaff(
      trx,
      this.context.orgId,
      this.context.actor.accountId,
      false,
    );
  }
  list() {
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      return trx
        .selectFrom('seasons')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .orderBy('starts_on', 'desc')
        .execute();
    });
  }
  create(input: z.input<typeof seasonCreateSchema>) {
    const value = seasonCreateSchema.parse(input);
    if (value.startsOn > value.endsOn)
      throw new SeasonError(
        400,
        'VALIDATION_ERROR',
        'Season end must follow start',
      );
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      return trx
        .insertInto('seasons')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          name: value.name,
          starts_on: day(value.startsOn),
          ends_on: day(value.endsOn),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  update(id: string, input: z.input<typeof seasonUpdateSchema>) {
    const value = seasonUpdateSchema.parse(input);
    const transitions: Record<string, string[]> = {
      planning: ['active', 'archived'],
      active: ['completed'],
      completed: ['archived'],
      archived: [],
    };
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      const current = await trx
        .selectFrom('seasons')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new SeasonError(404, 'NOT_FOUND', 'Season not found');
      if (current.version !== value.expectedVersion)
        throw new SeasonError(
          409,
          'VERSION_CONFLICT',
          'Season changed; reload before saving',
        );
      if (
        value.status &&
        value.status !== current.status &&
        !transitions[current.status]?.includes(value.status)
      )
        throw new SeasonError(
          409,
          'CONFLICT',
          'Invalid season status transition',
        );
      const starts = value.startsOn ?? dateOnly(current.starts_on);
      const ends = value.endsOn ?? dateOnly(current.ends_on);
      if (starts > ends)
        throw new SeasonError(
          400,
          'VALIDATION_ERROR',
          'Season end must follow start',
        );
      return trx
        .updateTable('seasons')
        .set({
          ...(value.name === undefined ? {} : { name: value.name }),
          ...(value.startsOn === undefined
            ? {}
            : { starts_on: day(value.startsOn) }),
          ...(value.endsOn === undefined ? {} : { ends_on: day(value.endsOn) }),
          ...(value.status === undefined ? {} : { status: value.status }),
          version: current.version + 1,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  async preview(id: string, input: z.input<typeof rolloverSchema>) {
    const value = rolloverSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      const source = await trx
        .selectFrom('seasons')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!source) throw new SeasonError(404, 'NOT_FOUND', 'Season not found');
      const programs = await trx
        .selectFrom('programs')
        .select(['id', 'name', 'starts_on', 'ends_on'])
        .where('org_id', '=', this.context.orgId)
        .where('season_id', '=', id)
        .where('status', '!=', 'archived')
        .execute();
      const teamSeasons = await trx
        .selectFrom('team_seasons as ts')
        .innerJoin('programs as p', 'p.id', 'ts.program_id')
        .innerJoin('teams as t', 't.id', 'ts.team_id')
        .select(['ts.id', 'ts.team_id', 'ts.program_id', 't.name'])
        .where('ts.org_id', '=', this.context.orgId)
        .where('p.season_id', '=', id)
        .where('ts.status', '!=', 'withdrawn')
        .execute();
      const staff = await trx
        .selectFrom('team_staff as s')
        .innerJoin('team_seasons as ts', 'ts.id', 's.team_season_id')
        .innerJoin('programs as p', 'p.id', 'ts.program_id')
        .select(['s.id', 's.team_season_id', 's.person_id', 's.role'])
        .where('s.org_id', '=', this.context.orgId)
        .where('p.season_id', '=', id)
        .where('s.status', '!=', 'removed')
        .execute();
      const selectedTeams = new Set(value.returningTeamSeasonIds);
      const selectedStaff = new Set(value.carryStaffIds);
      if (
        staff.some(
          (member) =>
            selectedStaff.has(member.id) &&
            !selectedTeams.has(member.team_season_id),
        )
      )
        throw new SeasonError(
          400,
          'VALIDATION_ERROR',
          'Cannot carry staff from an excluded team',
        );
      return {
        source: {
          id: source.id,
          name: source.name,
          startsOn: dateOnly(source.starts_on),
          endsOn: dateOnly(source.ends_on),
        },
        target: {
          name: value.name,
          startsOn: value.startsOn,
          endsOn: value.endsOn,
        },
        programs: programs.map((p) => ({
          id: p.id,
          name: p.name,
          startsOn: dateOnly(p.starts_on),
          copiedStartsOn: resolveDate(
            p.starts_on,
            value.offsetDays,
            value.dateMap,
          ),
          copiedEndsOn: resolveDate(p.ends_on, value.offsetDays, value.dateMap),
        })),
        teams: teamSeasons.map((team) => ({
          ...team,
          returning: selectedTeams.has(team.id),
        })),
        staff: staff.map((member) => ({
          ...member,
          carryOver: selectedStaff.has(member.id),
        })),
        exclusions: ['registrations', 'invoices', 'payments', 'results'],
      };
    });
  }
  async rolloverInTransaction(
    trx: OrgTransaction,
    sourceId: string,
    input: z.input<typeof rolloverSchema>,
  ) {
    const value = rolloverSchema.parse(input);
    if (value.startsOn > value.endsOn)
      throw new SeasonError(
        400,
        'VALIDATION_ERROR',
        'Season end must follow start',
      );
    await this.staff(trx);
    const source = await trx
      .selectFrom('seasons')
      .select('id')
      .where('org_id', '=', this.context.orgId)
      .where('id', '=', sourceId)
      .forUpdate()
      .executeTakeFirst();
    if (!source) throw new SeasonError(404, 'NOT_FOUND', 'Season not found');
    const org = await trx
      .selectFrom('organizations')
      .select('timezone')
      .where('id', '=', this.context.orgId)
      .executeTakeFirstOrThrow();
    const oldPrograms = await trx
      .selectFrom('programs')
      .selectAll()
      .where('org_id', '=', this.context.orgId)
      .where('season_id', '=', sourceId)
      .where('status', '!=', 'archived')
      .execute();
    const target = await trx
      .insertInto('seasons')
      .values({
        id: newId(),
        org_id: this.context.orgId,
        name: value.name,
        starts_on: day(value.startsOn),
        ends_on: day(value.endsOn),
        copied_from_season_id: sourceId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const programIds = new Map<string, string>();
    const divisionIds = new Map<string, string>();
    const teamSeasonIds = new Map<string, string>();
    const suffix = value.startsOn.slice(0, 4);
    for (const old of oldPrograms) {
      const id = newId();
      programIds.set(old.id, id);
      const startsOn = resolveDate(
        old.starts_on,
        value.offsetDays,
        value.dateMap,
      );
      const endsOn = resolveDate(old.ends_on, value.offsetDays, value.dateMap);
      if (startsOn > endsOn)
        throw new SeasonError(
          400,
          'VALIDATION_ERROR',
          `Copied dates for "${old.name}" end before they start`,
        );
      await trx
        .insertInto('programs')
        .values({
          id,
          org_id: this.context.orgId,
          season_id: target.id,
          sport_profile_id: old.sport_profile_id,
          mode: old.mode,
          name: old.name,
          slug: `${old.slug}-${suffix}-${target.id.slice(0, 8)}`,
          status: 'draft',
          visibility: old.visibility,
          starts_on: startsOn,
          ends_on: endsOn,
          registration_opens_at: resolveInstant(
            old.registration_opens_at,
            value.offsetDays,
            value.dateMap,
            org.timezone,
          ),
          registration_closes_at: resolveInstant(
            old.registration_closes_at,
            value.offsetDays,
            value.dateMap,
            org.timezone,
          ),
          late_registration_closes_at: resolveInstant(
            old.late_registration_closes_at,
            value.offsetDays,
            value.dateMap,
            org.timezone,
          ),
          eligibility: old.eligibility,
          default_facility_id: old.default_facility_id,
          description_html: old.description_html,
          settings: old.settings,
          copied_from_program_id: old.id,
        })
        .execute();
      const oldDivisions = await trx
        .selectFrom('divisions')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('program_id', '=', old.id)
        .execute();
      const insertedDefault = await trx
        .selectFrom('divisions')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('program_id', '=', id)
        .where('is_default', '=', true)
        .executeTakeFirstOrThrow();
      for (const division of oldDivisions) {
        if (division.is_default) {
          divisionIds.set(division.id, insertedDefault.id);
          await trx
            .updateTable('divisions')
            .set({
              name: division.name,
              code: division.code,
              age_label: division.age_label,
              eligibility: division.eligibility,
              competition_gender: division.competition_gender,
              level: division.level,
              capacity_players: division.capacity_players,
              capacity_teams: division.capacity_teams,
              sort_order: division.sort_order,
            })
            .where('id', '=', insertedDefault.id)
            .execute();
          continue;
        }
        const newIdValue = newId();
        divisionIds.set(division.id, newIdValue);
        await trx
          .insertInto('divisions')
          .values({
            id: newIdValue,
            org_id: this.context.orgId,
            program_id: id,
            name: division.name,
            code: division.code,
            age_label: division.age_label,
            eligibility: division.eligibility,
            competition_gender: division.competition_gender,
            level: division.level,
            capacity_players: division.capacity_players,
            capacity_teams: division.capacity_teams,
            sort_order: division.sort_order,
          })
          .execute();
      }
      const offerings = await trx
        .selectFrom('registration_offerings')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('program_id', '=', old.id)
        .execute();
      for (const offering of offerings)
        await trx
          .insertInto('registration_offerings')
          .values({
            id: newId(),
            org_id: this.context.orgId,
            program_id: id,
            division_id: offering.division_id
              ? (divisionIds.get(offering.division_id) ?? null)
              : null,
            name: offering.name,
            registrant_role: offering.registrant_role,
            price_cents: offering.price_cents,
            pricing: offering.pricing,
            capacity: offering.capacity,
            waitlist_enabled: offering.waitlist_enabled,
            requires_approval: offering.requires_approval,
            form_definition_ids: offering.form_definition_ids,
            waiver_document_ids: offering.waiver_document_ids,
            add_ons: offering.add_ons,
            visibility: offering.visibility,
            sort_order: offering.sort_order,
            active: false,
          })
          .execute();
    }
    const oldTeamSeasons = await trx
      .selectFrom('team_seasons')
      .selectAll()
      .where('org_id', '=', this.context.orgId)
      .where(
        'program_id',
        'in',
        oldPrograms.map((p) => p.id).length
          ? oldPrograms.map((p) => p.id)
          : [sourceId],
      )
      .execute();
    const returning = new Set(value.returningTeamSeasonIds);
    for (const old of oldTeamSeasons) {
      if (!returning.has(old.id)) continue;
      const programId = programIds.get(old.program_id);
      const divisionId = divisionIds.get(old.division_id);
      if (!programId || !divisionId)
        throw new SeasonError(
          400,
          'VALIDATION_ERROR',
          'Selected team belongs to an excluded program',
        );
      const id = newId();
      teamSeasonIds.set(old.id, id);
      await trx
        .insertInto('team_seasons')
        .values({
          id,
          org_id: this.context.orgId,
          team_id: old.team_id,
          program_id: programId,
          division_id: divisionId,
          display_name: old.display_name,
          roster_limit: old.roster_limit,
          status: 'forming',
          home_facility_id: old.home_facility_id,
          practice_preferences: old.practice_preferences,
        })
        .execute();
    }
    const oldStaff = await trx
      .selectFrom('team_staff')
      .selectAll()
      .where('org_id', '=', this.context.orgId)
      .where(
        'team_season_id',
        'in',
        oldTeamSeasons.map((team) => team.id).length
          ? oldTeamSeasons.map((team) => team.id)
          : [sourceId],
      )
      .where('status', '!=', 'removed')
      .execute();
    const carry = new Set(value.carryStaffIds);
    const staffIds = new Map<string, string>();
    for (const member of oldStaff) {
      if (!carry.has(member.id)) continue;
      const teamSeasonId = teamSeasonIds.get(member.team_season_id);
      if (!teamSeasonId)
        throw new SeasonError(
          400,
          'VALIDATION_ERROR',
          'Cannot carry staff from an excluded team',
        );
      const staffId = newId();
      staffIds.set(member.id, staffId);
      await trx
        .insertInto('team_staff')
        .values({
          id: staffId,
          org_id: this.context.orgId,
          team_season_id: teamSeasonId,
          person_id: member.person_id,
          role: member.role,
          status: 'pending_compliance',
          added_by: this.context.actor.accountId,
        })
        .execute();
    }
    const oldTeamIds = oldTeamSeasons.map((team) => team.id);
    const oldDivisionIds = [...divisionIds.keys()];
    const oldAllocations = await trx
      .selectFrom('allocations')
      .selectAll()
      .where('org_id', '=', this.context.orgId)
      .where((eb) =>
        eb.or([
          eb(
            'team_season_id',
            'in',
            oldTeamIds.length ? oldTeamIds : [sourceId],
          ),
          eb(
            'division_id',
            'in',
            oldDivisionIds.length ? oldDivisionIds : [sourceId],
          ),
        ]),
      )
      .where('status', '=', 'active')
      .execute();
    for (const allocation of oldAllocations) {
      const teamSeasonId = allocation.team_season_id
        ? teamSeasonIds.get(allocation.team_season_id)
        : undefined;
      const divisionId = allocation.division_id
        ? divisionIds.get(allocation.division_id)
        : undefined;
      if (!teamSeasonId && !divisionId) continue;
      await trx
        .insertInto('allocations')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          space_id: allocation.space_id,
          team_season_id: teamSeasonId ?? null,
          division_id: divisionId ?? null,
          rrule: allocation.rrule,
          recurrence: allocation.recurrence,
          starts_on: resolveDate(
            allocation.starts_on,
            value.offsetDays,
            value.dateMap,
          ),
          ends_on: resolveDate(
            allocation.ends_on,
            value.offsetDays,
            value.dateMap,
          ),
          start_time: allocation.start_time,
          end_time: allocation.end_time,
          purpose: allocation.purpose,
          status: 'active',
        })
        .execute();
    }
    const ids: RolloverIdMap = {
      seasonId: target.id,
      programIds,
      divisionIds,
      teamSeasonIds,
      staffIds,
    };
    for (const extra of this.extras) await extra(trx, ids);
    return {
      season: target,
      copied: {
        programs: programIds.size,
        teams: teamSeasonIds.size,
        staff: staffIds.size,
      },
    };
  }
}
