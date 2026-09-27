import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types';
import { createWithOrg, type OrgContext } from '../../db/withOrg';
import {
  assertEligibleForRole,
  RoleEligibilityError,
} from '../compliance/policy';
import { requireStaff } from '../people/repo';

export const teamInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  shortName: z.string().trim().max(30).nullable().default(null),
  sportProfileId: z.uuid(),
  competitionGender: z
    .enum(['male', 'female', 'open'])
    .nullable()
    .default(null),
  birthYear: z.number().int().min(1900).max(2200).nullable().default(null),
  ageLabel: z.string().trim().max(40).nullable().default(null),
  level: z
    .enum(['recreational', 'developmental', 'competitive', 'elite', 'open'])
    .default('open'),
  colors: z.record(z.string(), z.string()).default({}),
});
export const teamSeasonInputSchema = z.strictObject({
  teamId: z.uuid(),
  programId: z.uuid(),
  divisionId: z.uuid(),
  displayName: z.string().trim().max(120).nullable().default(null),
  rosterLimit: z.number().int().positive().nullable().default(null),
  homeFacilityId: z.uuid().nullable().default(null),
});
export const teamGeneratorSchema = z.strictObject({
  programId: z.uuid(),
  divisionId: z.uuid(),
  count: z.number().int().min(1).max(100),
  pattern: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((text) => text.includes('{n}'), 'Naming pattern needs {n}'),
});
export const staffInputSchema = z.strictObject({
  personId: z.uuid(),
  role: z.enum([
    'head_coach',
    'assistant_coach',
    'team_manager',
    'trainer',
    'treasurer',
    'other',
  ]),
});
export class TeamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class TeamsService {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    private readonly database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }
  list(programId?: string) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      let query = trx
        .selectFrom('team_seasons as ts')
        .innerJoin('teams as t', 't.id', 'ts.team_id')
        .select([
          'ts.id',
          'ts.team_id',
          'ts.program_id',
          'ts.division_id',
          'ts.display_name',
          'ts.status',
          'ts.roster_limit',
          'ts.roster_locked_at',
          'ts.version',
          't.name',
          't.sport_profile_id',
        ])
        .where('ts.org_id', '=', this.context.orgId);
      if (programId) query = query.where('ts.program_id', '=', programId);
      return query.orderBy('t.name').execute();
    });
  }
  createTeam(input: z.input<typeof teamInputSchema>) {
    const value = teamInputSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const profile = await trx
        .selectFrom('sport_profiles')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.sportProfileId)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (!profile)
        throw new TeamError(404, 'NOT_FOUND', 'Sport profile not found');
      return trx
        .insertInto('teams')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          name: value.name,
          short_name: value.shortName,
          sport_profile_id: value.sportProfileId,
          competition_gender: value.competitionGender,
          birth_year: value.birthYear,
          age_label: value.ageLabel,
          level: value.level,
          colors: value.colors as Json,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  joinProgram(input: z.input<typeof teamSeasonInputSchema>) {
    const value = teamSeasonInputSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const team = await trx
        .selectFrom('teams')
        .select(['id', 'sport_profile_id'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.teamId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      const program = await trx
        .selectFrom('programs')
        .select(['id', 'sport_profile_id'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.programId)
        .executeTakeFirst();
      const division = await trx
        .selectFrom('divisions')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('program_id', '=', value.programId)
        .where('id', '=', value.divisionId)
        .executeTakeFirst();
      if (
        !team ||
        !program ||
        !division ||
        team.sport_profile_id !== program.sport_profile_id
      )
        throw new TeamError(
          400,
          'VALIDATION_ERROR',
          'Team, program and division must share this organization and sport',
        );
      return trx
        .insertInto('team_seasons')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          team_id: value.teamId,
          program_id: value.programId,
          division_id: value.divisionId,
          display_name: value.displayName,
          roster_limit: value.rosterLimit,
          home_facility_id: value.homeFacilityId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  generate(input: z.input<typeof teamGeneratorSchema>) {
    const value = teamGeneratorSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const program = await trx
        .selectFrom('programs')
        .select('sport_profile_id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.programId)
        .executeTakeFirst();
      const division = await trx
        .selectFrom('divisions')
        .select(['age_label', 'competition_gender', 'level'])
        .where('org_id', '=', this.context.orgId)
        .where('program_id', '=', value.programId)
        .where('id', '=', value.divisionId)
        .executeTakeFirst();
      if (!program || !division)
        throw new TeamError(404, 'NOT_FOUND', 'Program or division not found');
      const rows = [];
      for (let n = 1; n <= value.count; n += 1) {
        const name = value.pattern
          .replaceAll('{n}', String(n))
          .replaceAll('{division}', division.age_label ?? 'Team');
        const team = await trx
          .insertInto('teams')
          .values({
            id: newId(),
            org_id: this.context.orgId,
            name,
            sport_profile_id: program.sport_profile_id,
            competition_gender: division.competition_gender,
            age_label: division.age_label,
            level: division.level,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const season = await trx
          .insertInto('team_seasons')
          .values({
            id: newId(),
            org_id: this.context.orgId,
            team_id: team.id,
            program_id: value.programId,
            division_id: value.divisionId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        rows.push({ team, season });
      }
      return rows;
    });
  }
  async assignStaff(
    teamSeasonId: string,
    input: z.input<typeof staffInputSchema>,
  ) {
    const value = staffInputSchema.parse(input);
    await this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
    });
    let eligible = false;
    if (value.role !== 'other') {
      try {
        await assertEligibleForRole(this.database, this.context, {
          personId: value.personId,
          role: value.role,
        });
        eligible = true;
      } catch (error) {
        if (!(error instanceof RoleEligibilityError)) throw error;
      }
    }
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const teamSeason = await trx
        .selectFrom('team_seasons')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', teamSeasonId)
        .executeTakeFirst();
      const person = await trx
        .selectFrom('people')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.personId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!teamSeason || !person)
        throw new TeamError(
          404,
          'NOT_FOUND',
          'Team season or person not found',
        );
      return trx
        .insertInto('team_staff')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          team_season_id: teamSeasonId,
          person_id: value.personId,
          role: value.role,
          status: eligible ? 'active' : 'pending_compliance',
          added_by: this.context.actor.accountId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  setRosterLock(
    teamSeasonId: string,
    expectedVersion: number,
    locked: boolean,
  ) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('team_seasons')
        .select('version')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', teamSeasonId)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new TeamError(404, 'NOT_FOUND', 'Team season not found');
      if (current.version !== expectedVersion)
        throw new TeamError(
          409,
          'VERSION_CONFLICT',
          'Team season changed; reload before saving',
        );
      return trx
        .updateTable('team_seasons')
        .set({
          roster_locked_at: locked ? new Date() : null,
          version: current.version + 1,
        })
        .where('id', '=', teamSeasonId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
}
