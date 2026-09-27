import { newId } from '@shared/ids';
import { sportProfileSchema } from '@shared/sport/schema';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg';
import { requireStaff } from '../people/repo';

export const rosterInputSchema = z.strictObject({
  personId: z.uuid(),
  registrationId: z.uuid().nullable().default(null),
  kind: z.enum(['rostered', 'guest', 'practice_only']).default('rostered'),
  jerseyNumber: z.string().trim().max(8).nullable().default(null),
  positions: z.array(z.string()).default([]),
});
export const rosterUpdateSchema = rosterInputSchema
  .pick({ jerseyNumber: true, positions: true })
  .partial()
  .extend({ expectedVersion: z.number().int().positive() });
export class RosterError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const translateUniqueViolation = (error: unknown): never => {
  if (error instanceof Error && 'code' in error && error.code === '23505') {
    const constraint =
      'constraint' in error && typeof error.constraint === 'string'
        ? error.constraint
        : '';
    throw new RosterError(
      409,
      'CONFLICT',
      constraint.includes('jersey')
        ? 'Jersey number is already taken on this team'
        : 'This person is already on the roster',
    );
  }
  throw error;
};

type TeamConfig = {
  teamSeasonId: string;
  profile: z.output<typeof sportProfileSchema>;
  rosterLimit: number | null;
  rosterLockedAt: Date | null;
  programId: string;
  settings: unknown;
};

export class RostersService {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }
  private async config(
    trx: OrgTransaction,
    teamSeasonId: string,
  ): Promise<TeamConfig> {
    const row = await trx
      .selectFrom('team_seasons as ts')
      .innerJoin('programs as p', 'p.id', 'ts.program_id')
      .innerJoin('sport_profiles as sp', 'sp.id', 'p.sport_profile_id')
      .select([
        'ts.id',
        'ts.roster_limit',
        'ts.roster_locked_at',
        'p.id as program_id',
        'p.settings',
        'sp.profile',
      ])
      .where('ts.org_id', '=', this.context.orgId)
      .where('ts.id', '=', teamSeasonId)
      .executeTakeFirst();
    if (!row) throw new RosterError(404, 'NOT_FOUND', 'Team season not found');
    return {
      teamSeasonId,
      profile: sportProfileSchema.parse(row.profile),
      rosterLimit: row.roster_limit,
      rosterLockedAt: row.roster_locked_at,
      programId: row.program_id,
      settings: row.settings,
    };
  }
  private validate(
    profile: TeamConfig['profile'],
    number: string | null,
    positions: string[],
  ) {
    if (profile.roster.jerseyNumbers === 'required' && !number)
      throw new RosterError(
        400,
        'VALIDATION_ERROR',
        'Jersey number is required',
      );
    if (profile.roster.jerseyNumbers === 'none' && number)
      throw new RosterError(
        400,
        'VALIDATION_ERROR',
        'This sport does not use jersey numbers',
      );
    if (number && profile.roster.jerseyRange) {
      const n = Number(number);
      if (
        !Number.isInteger(n) ||
        n < profile.roster.jerseyRange[0] ||
        n > profile.roster.jerseyRange[1]
      )
        throw new RosterError(
          400,
          'VALIDATION_ERROR',
          'Jersey number is outside the sport range',
        );
    }
    if (
      positions.length > profile.maxPositionsPerAthlete ||
      positions.some(
        (position) =>
          !profile.positions.some((allowed) => allowed.key === position),
      ) ||
      new Set(positions).size !== positions.length
    )
      throw new RosterError(
        400,
        'VALIDATION_ERROR',
        'Choose allowed sport positions',
      );
  }
  list(teamSeasonId: string) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      await this.config(trx, teamSeasonId);
      return trx
        .selectFrom('roster_entries as r')
        .innerJoin('people as p', 'p.id', 'r.person_id')
        .select([
          'r.id',
          'r.team_season_id',
          'r.person_id',
          'r.kind',
          'r.jersey_number',
          'r.positions',
          'r.status',
          'r.version',
          'p.first_name',
          'p.last_name',
        ])
        .where('r.org_id', '=', this.context.orgId)
        .where('r.team_season_id', '=', teamSeasonId)
        .where('r.status', '!=', 'released')
        .orderBy('p.last_name')
        .orderBy('p.first_name')
        .execute();
    });
  }
  add(teamSeasonId: string, input: z.input<typeof rosterInputSchema>) {
    const value = rosterInputSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const config = await this.config(trx, teamSeasonId);
      if (config.rosterLockedAt)
        throw new RosterError(409, 'ROSTER_LOCKED', 'Roster is locked');
      this.validate(config.profile, value.jerseyNumber, value.positions);
      const person = await trx
        .selectFrom('people')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.personId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!person) throw new RosterError(404, 'NOT_FOUND', 'Person not found');
      if (value.registrationId) {
        const registration = await trx
          .selectFrom('registrations')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('id', '=', value.registrationId)
          .where('person_id', '=', value.personId)
          .where('program_id', '=', config.programId)
          .where('status', '=', 'confirmed')
          .executeTakeFirst();
        if (!registration)
          throw new RosterError(
            400,
            'VALIDATION_ERROR',
            'Registration must be confirmed for this person and program',
          );
      }
      const active = await trx
        .selectFrom('roster_entries')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('team_season_id', '=', teamSeasonId)
        .where('status', 'in', ['active', 'injured', 'suspended'])
        .forUpdate()
        .execute();
      const limit = config.rosterLimit ?? config.profile.roster.defaultMax;
      if (active.length >= limit)
        throw new RosterError(409, 'CAPACITY_FULL', 'Roster limit reached');
      if (value.kind === 'guest') {
        const settings =
          config.settings &&
          typeof config.settings === 'object' &&
          !Array.isArray(config.settings)
            ? (config.settings as Record<string, unknown>)
            : {};
        const maxGuests =
          typeof settings.maxGuestPlayers === 'number'
            ? settings.maxGuestPlayers
            : 0;
        const guests = await trx
          .selectFrom('roster_entries')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('team_season_id', '=', teamSeasonId)
          .where('kind', '=', 'guest')
          .where('status', 'in', ['active', 'injured', 'suspended'])
          .execute();
        if (guests.length >= maxGuests)
          throw new RosterError(
            409,
            'CAPACITY_FULL',
            'Guest player limit reached',
          );
      }
      try {
        return await trx
          .insertInto('roster_entries')
          .values({
            id: newId(),
            org_id: this.context.orgId,
            team_season_id: teamSeasonId,
            person_id: value.personId,
            registration_id: value.registrationId,
            kind: value.kind,
            jersey_number: value.jerseyNumber,
            positions: value.positions,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        translateUniqueViolation(error);
      }
    });
  }
  update(id: string, input: z.input<typeof rosterUpdateSchema>) {
    const value = rosterUpdateSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('roster_entries')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new RosterError(404, 'NOT_FOUND', 'Roster entry not found');
      const config = await this.config(trx, current.team_season_id);
      if (config.rosterLockedAt)
        throw new RosterError(409, 'ROSTER_LOCKED', 'Roster is locked');
      if (current.version !== value.expectedVersion)
        throw new RosterError(
          409,
          'VERSION_CONFLICT',
          'Roster changed; reload before saving',
        );
      this.validate(
        config.profile,
        value.jerseyNumber === undefined
          ? current.jersey_number
          : value.jerseyNumber,
        value.positions ?? current.positions,
      );
      try {
        return await trx
          .updateTable('roster_entries')
          .set({
            ...(value.jerseyNumber === undefined
              ? {}
              : { jersey_number: value.jerseyNumber }),
            ...(value.positions === undefined
              ? {}
              : { positions: value.positions }),
            version: current.version + 1,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        translateUniqueViolation(error);
      }
    });
  }
  move(id: string, destinationTeamSeasonId: string, expectedVersion: number) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('roster_entries')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new RosterError(404, 'NOT_FOUND', 'Roster entry not found');
      const source = await this.config(trx, current.team_season_id);
      const destination = await this.config(trx, destinationTeamSeasonId);
      if (source.rosterLockedAt || destination.rosterLockedAt)
        throw new RosterError(409, 'ROSTER_LOCKED', 'Roster is locked');
      if (current.version !== expectedVersion)
        throw new RosterError(
          409,
          'VERSION_CONFLICT',
          'Roster changed; reload before saving',
        );
      if (source.programId !== destination.programId)
        throw new RosterError(
          400,
          'VALIDATION_ERROR',
          'Move between teams in the same program',
        );
      this.validate(
        destination.profile,
        current.jersey_number,
        current.positions,
      );
      try {
        return await trx
          .updateTable('roster_entries')
          .set({
            team_season_id: destinationTeamSeasonId,
            version: current.version + 1,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        translateUniqueViolation(error);
      }
    });
  }
  release(id: string, expectedVersion: number) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('roster_entries')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new RosterError(404, 'NOT_FOUND', 'Roster entry not found');
      const config = await this.config(trx, current.team_season_id);
      if (config.rosterLockedAt)
        throw new RosterError(409, 'ROSTER_LOCKED', 'Roster is locked');
      if (current.version !== expectedVersion)
        throw new RosterError(
          409,
          'VERSION_CONFLICT',
          'Roster changed; reload before saving',
        );
      return trx
        .updateTable('roster_entries')
        .set({
          status: 'released',
          left_on: new Date(),
          version: current.version + 1,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
}

export function rosterCsv(
  rows: Awaited<ReturnType<RostersService['list']>>,
): string {
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return [
    'First name,Last name,Jersey,Positions,Status',
    ...rows.map((row) =>
      [
        row.first_name,
        row.last_name,
        row.jersey_number ?? '',
        row.positions.join('; '),
        row.status,
      ]
        .map(cell)
        .join(','),
    ),
  ].join('\r\n');
}
