import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types';
import { createWithOrg, type OrgContext } from '../../db/withOrg';
import { requireStaff } from '../people/repo';

import {
  divisionGeneratorSchema,
  generateDivisions,
} from './division-generator';

export const programInputSchema = z.strictObject({
  seasonId: z.uuid(),
  sportProfileId: z.uuid(),
  mode: z.enum([
    'league',
    'club',
    'class',
    'camp',
    'clinic',
    'tryout',
    'tournament',
    'event',
    'membership',
  ]),
  name: z.string().trim().min(1).max(160),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  visibility: z.enum(['public', 'unlisted', 'private']).default('private'),
  descriptionHtml: z.string().max(100_000).nullable().default(null),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export const programUpdateSchema = programInputSchema
  .partial()
  .extend({ expectedVersion: z.number().int().positive() });
export const divisionInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(30).nullable().default(null),
  ageLabel: z.string().trim().max(40).nullable().default(null),
  competitionGender: z
    .enum(['male', 'female', 'open'])
    .nullable()
    .default(null),
  level: z
    .enum(['recreational', 'developmental', 'competitive', 'elite', 'open'])
    .default('open'),
  eligibility: z.record(z.string(), z.unknown()).default({}),
  capacityPlayers: z.number().int().nonnegative().nullable().default(null),
  capacityTeams: z.number().int().nonnegative().nullable().default(null),
});

export class ProgramError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

export class ProgramsService {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }
  private async staff(
    trx: Parameters<Parameters<ReturnType<typeof createWithOrg>>[1]>[0],
  ) {
    await requireStaff(
      trx,
      this.context.orgId,
      this.context.actor.accountId,
      false,
    );
  }
  list(seasonId?: string) {
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      let query = trx
        .selectFrom('programs')
        .selectAll()
        .where('org_id', '=', this.context.orgId);
      if (seasonId) query = query.where('season_id', '=', seasonId);
      return query.orderBy('starts_on', 'desc').execute();
    });
  }
  get(id: string) {
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      const program = await trx
        .selectFrom('programs')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!program)
        throw new ProgramError(404, 'NOT_FOUND', 'Program not found');
      const [divisions, offerings] = await Promise.all([
        trx
          .selectFrom('divisions')
          .selectAll()
          .where('org_id', '=', this.context.orgId)
          .where('program_id', '=', id)
          .orderBy('sort_order')
          .execute(),
        trx
          .selectFrom('registration_offerings')
          .selectAll()
          .where('org_id', '=', this.context.orgId)
          .where('program_id', '=', id)
          .orderBy('sort_order')
          .execute(),
      ]);
      return { program, divisions, offerings };
    });
  }
  create(input: z.input<typeof programInputSchema>) {
    const value = programInputSchema.parse(input);
    if (value.startsOn > value.endsOn)
      throw new ProgramError(
        400,
        'VALIDATION_ERROR',
        'Program end must follow start',
      );
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      const season = await trx
        .selectFrom('seasons')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.seasonId)
        .executeTakeFirst();
      const profile = await trx
        .selectFrom('sport_profiles')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.sportProfileId)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (!season || !profile)
        throw new ProgramError(
          404,
          'NOT_FOUND',
          'Season or sport profile not found',
        );
      const program = await trx
        .insertInto('programs')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          season_id: value.seasonId,
          sport_profile_id: value.sportProfileId,
          mode: value.mode,
          name: value.name,
          slug: value.slug,
          starts_on: day(value.startsOn),
          ends_on: day(value.endsOn),
          visibility: value.visibility,
          description_html: value.descriptionHtml,
          settings: value.settings as Json,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return program;
    });
  }
  update(id: string, input: z.input<typeof programUpdateSchema>) {
    const value = programUpdateSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      const current = await trx
        .selectFrom('programs')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new ProgramError(404, 'NOT_FOUND', 'Program not found');
      if (current.version !== value.expectedVersion)
        throw new ProgramError(
          409,
          'VERSION_CONFLICT',
          'Program changed; reload before saving',
        );
      if (
        value.slug &&
        value.slug !== current.slug &&
        !['draft', 'archived'].includes(current.status)
      )
        throw new ProgramError(
          409,
          'CONFLICT',
          'Unpublish before changing the program URL',
        );
      const starts =
        value.startsOn ?? current.starts_on.toISOString().slice(0, 10);
      const ends = value.endsOn ?? current.ends_on.toISOString().slice(0, 10);
      if (starts > ends)
        throw new ProgramError(
          400,
          'VALIDATION_ERROR',
          'Program end must follow start',
        );
      return trx
        .updateTable('programs')
        .set({
          ...(value.name !== undefined ? { name: value.name } : {}),
          ...(value.slug !== undefined ? { slug: value.slug } : {}),
          ...(value.startsOn !== undefined
            ? { starts_on: day(value.startsOn) }
            : {}),
          ...(value.endsOn !== undefined ? { ends_on: day(value.endsOn) } : {}),
          ...(value.visibility !== undefined
            ? { visibility: value.visibility }
            : {}),
          ...(value.descriptionHtml !== undefined
            ? { description_html: value.descriptionHtml }
            : {}),
          ...(value.settings !== undefined
            ? { settings: value.settings as Json }
            : {}),
          version: current.version + 1,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  setStatus(
    id: string,
    status:
      | 'draft'
      | 'published'
      | 'registration_open'
      | 'registration_closed'
      | 'in_progress'
      | 'completed'
      | 'archived',
    expectedVersion: number,
  ) {
    const allowed: Record<string, string[]> = {
      draft: ['published', 'archived'],
      published: ['draft', 'registration_open', 'archived'],
      registration_open: ['registration_closed', 'in_progress'],
      registration_closed: ['registration_open', 'in_progress', 'archived'],
      in_progress: ['completed'],
      completed: ['archived'],
      archived: ['draft'],
    };
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      const current = await trx
        .selectFrom('programs')
        .select(['status', 'version'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new ProgramError(404, 'NOT_FOUND', 'Program not found');
      if (current.version !== expectedVersion)
        throw new ProgramError(
          409,
          'VERSION_CONFLICT',
          'Program changed; reload before saving',
        );
      if (!allowed[current.status]?.includes(status))
        throw new ProgramError(
          409,
          'CONFLICT',
          'Invalid program status transition',
        );
      return trx
        .updateTable('programs')
        .set({ status, version: current.version + 1 })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  addDivision(programId: string, input: z.input<typeof divisionInputSchema>) {
    const value = divisionInputSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      const program = await trx
        .selectFrom('programs')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', programId)
        .executeTakeFirst();
      if (!program)
        throw new ProgramError(404, 'NOT_FOUND', 'Program not found');
      const row = await trx
        .insertInto('divisions')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          program_id: programId,
          name: value.name,
          code: value.code,
          age_label: value.ageLabel,
          competition_gender: value.competitionGender,
          level: value.level,
          eligibility: value.eligibility as Json,
          capacity_players: value.capacityPlayers,
          capacity_teams: value.capacityTeams,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const removed = await trx
        .deleteFrom('divisions')
        .where('org_id', '=', this.context.orgId)
        .where('program_id', '=', programId)
        .where('is_default', '=', true)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('registrations')
                .select('id')
                .whereRef('registrations.division_id', '=', 'divisions.id'),
            ),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('registration_offerings')
                .select('id')
                .whereRef(
                  'registration_offerings.division_id',
                  '=',
                  'divisions.id',
                ),
            ),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('team_seasons')
                .select('id')
                .whereRef('team_seasons.division_id', '=', 'divisions.id'),
            ),
          ),
        )
        .returning('id')
        .execute();
      if (removed.length)
        return trx
          .updateTable('divisions')
          .set({ is_default: true })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      return row;
    });
  }
  generate(programId: string, input: z.input<typeof divisionGeneratorSchema>) {
    const divisions = generateDivisions(divisionGeneratorSchema.parse(input));
    return this.withOrg(this.context, async (trx) => {
      await this.staff(trx);
      const program = await trx
        .selectFrom('programs')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', programId)
        .executeTakeFirst();
      if (!program)
        throw new ProgramError(404, 'NOT_FOUND', 'Program not found');
      const rows = await trx
        .insertInto('divisions')
        .values(
          divisions.map((item) => ({
            id: newId(),
            org_id: this.context.orgId,
            program_id: programId,
            name: item.name,
            code: item.code,
            age_label: item.ageLabel,
            competition_gender: item.competitionGender,
            eligibility: item.eligibility as Json,
            sort_order: item.sortOrder,
          })),
        )
        .returningAll()
        .execute();
      const removed = await trx
        .deleteFrom('divisions')
        .where('org_id', '=', this.context.orgId)
        .where('program_id', '=', programId)
        .where('is_default', '=', true)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('registrations')
                .select('id')
                .whereRef('registrations.division_id', '=', 'divisions.id'),
            ),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('registration_offerings')
                .select('id')
                .whereRef(
                  'registration_offerings.division_id',
                  '=',
                  'divisions.id',
                ),
            ),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('team_seasons')
                .select('id')
                .whereRef('team_seasons.division_id', '=', 'divisions.id'),
            ),
          ),
        )
        .returning('id')
        .execute();
      if (removed.length && rows[0]) {
        rows[0] = await trx
          .updateTable('divisions')
          .set({ is_default: true })
          .where('id', '=', rows[0].id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return rows;
    });
  }
}
