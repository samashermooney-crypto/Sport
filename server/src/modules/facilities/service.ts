import { newId } from '@shared/ids';
import { recurrenceSchema } from '@shared/recurrence';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types';
import { createWithOrg, type OrgContext } from '../../db/withOrg';
import { requireStaff } from '../people/repo';

export const facilityInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  ownership: z.enum(['owned', 'permitted', 'partner']),
  address: z.record(z.string(), z.string()).nullable().default(null),
  timezone: z.string().nullable().default(null),
  parkingNotes: z.string().max(4000).nullable().default(null),
  mapUrl: z.url().nullable().default(null),
  public: z.boolean().default(false),
});
export const spaceInputSchema = z.strictObject({
  facilityId: z.uuid(),
  parentSpaceId: z.uuid().nullable().default(null),
  name: z.string().trim().min(1).max(160),
  kind: z.enum([
    'field',
    'court',
    'rink',
    'pool',
    'lanes',
    'mat',
    'diamond',
    'track',
    'room',
    'other',
  ]),
  surface: z.string().trim().max(100).nullable().default(null),
  hasLights: z.boolean().default(false),
  suitability: z.record(z.string(), z.unknown()).default({}),
  capacityPeople: z.number().int().nonnegative().nullable().default(null),
});
export const availabilityInputSchema = z.strictObject({
  spaceId: z.uuid(),
  recurrence: recurrenceSchema,
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  source: z.enum(['owned', 'permit']),
  permitReference: z.string().max(200).nullable().default(null),
  costPerHourCents: z.number().int().nonnegative().nullable().default(null),
});
export const blackoutInputSchema = z.strictObject({
  spaceId: z.uuid().nullable().default(null),
  facilityId: z.uuid().nullable().default(null),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
});
export class FacilityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

export class FacilitiesService {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }
  list() {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const facilities = await trx
        .selectFrom('facilities')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('archived_at', 'is', null)
        .orderBy('name')
        .execute();
      const spaces = await trx
        .selectFrom('spaces')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('archived_at', 'is', null)
        .orderBy('name')
        .execute();
      return { facilities, spaces };
    });
  }
  createFacility(input: z.input<typeof facilityInputSchema>) {
    const value = facilityInputSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      return trx
        .insertInto('facilities')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          name: value.name,
          ownership: value.ownership,
          address: value.address as Json,
          timezone: value.timezone,
          parking_notes: value.parkingNotes,
          map_url: value.mapUrl,
          public: value.public,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  updateFacility(
    id: string,
    expectedVersion: number,
    input: z.input<typeof facilityInputSchema>,
  ) {
    const value = facilityInputSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('facilities')
        .select('version')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .where('archived_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new FacilityError(404, 'NOT_FOUND', 'Facility not found');
      if (current.version !== expectedVersion)
        throw new FacilityError(
          409,
          'VERSION_CONFLICT',
          'Facility changed; reload before saving',
        );
      return trx
        .updateTable('facilities')
        .set({
          name: value.name,
          ownership: value.ownership,
          address: value.address as Json,
          timezone: value.timezone,
          parking_notes: value.parkingNotes,
          map_url: value.mapUrl,
          public: value.public,
          version: current.version + 1,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  createSpace(input: z.input<typeof spaceInputSchema>) {
    const value = spaceInputSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const facility = await trx
        .selectFrom('facilities')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.facilityId)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (!facility)
        throw new FacilityError(404, 'NOT_FOUND', 'Facility not found');
      if (value.parentSpaceId) {
        const parent = await trx
          .selectFrom('spaces')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('facility_id', '=', value.facilityId)
          .where('id', '=', value.parentSpaceId)
          .where('archived_at', 'is', null)
          .executeTakeFirst();
        if (!parent)
          throw new FacilityError(
            400,
            'VALIDATION_ERROR',
            'Parent space must be in the same facility',
          );
      }
      return trx
        .insertInto('spaces')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          facility_id: value.facilityId,
          parent_space_id: value.parentSpaceId,
          name: value.name,
          kind: value.kind,
          surface: value.surface,
          has_lights: value.hasLights,
          suitability: value.suitability as Json,
          capacity_people: value.capacityPeople,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  availability(spaceId: string) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      return trx
        .selectFrom('space_availability')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('space_id', '=', spaceId)
        .orderBy('starts_on')
        .execute();
    });
  }
  addAvailability(input: z.input<typeof availabilityInputSchema>) {
    const value = availabilityInputSchema.parse(input);
    if (value.startTime >= value.endTime)
      throw new FacilityError(
        400,
        'VALIDATION_ERROR',
        'Availability end must follow start',
      );
    if (value.recurrence.kind === 'once')
      throw new FacilityError(
        400,
        'VALIDATION_ERROR',
        'Use a weekly or monthly availability window',
      );
    const startsOn = value.recurrence.startsOn;
    const endsOn = value.recurrence.endsOn ?? '2099-12-31';
    if (startsOn > endsOn)
      throw new FacilityError(
        400,
        'VALIDATION_ERROR',
        'Availability end must follow start',
      );
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const space = await trx
        .selectFrom('spaces')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.spaceId)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (!space) throw new FacilityError(404, 'NOT_FOUND', 'Space not found');
      return trx
        .insertInto('space_availability')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          space_id: value.spaceId,
          rrule: '',
          recurrence: value.recurrence as Json,
          starts_on: day(startsOn),
          ends_on: day(endsOn),
          start_time: value.startTime,
          end_time: value.endTime,
          source: value.source,
          permit_reference: value.permitReference,
          cost_per_hour_cents: value.costPerHourCents,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  addBlackout(input: z.input<typeof blackoutInputSchema>) {
    const value = blackoutInputSchema.parse(input);
    if (
      Boolean(value.spaceId) === Boolean(value.facilityId) ||
      value.startsAt >= value.endsAt
    )
      throw new FacilityError(
        400,
        'VALIDATION_ERROR',
        'Choose one space or facility and a valid time window',
      );
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const target = value.spaceId
        ? await trx
            .selectFrom('spaces')
            .select('id')
            .where('org_id', '=', this.context.orgId)
            .where('id', '=', value.spaceId)
            .executeTakeFirst()
        : await trx
            .selectFrom('facilities')
            .select('id')
            .where('org_id', '=', this.context.orgId)
            .where('id', '=', value.facilityId)
            .executeTakeFirst();
      if (!target)
        throw new FacilityError(
          404,
          'NOT_FOUND',
          'Space or facility not found',
        );
      return trx
        .insertInto('space_blackouts')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          space_id: value.spaceId,
          facility_id: value.facilityId,
          starts_at: new Date(value.startsAt),
          ends_at: new Date(value.endsAt),
          reason: value.reason,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  blackouts() {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      return trx
        .selectFrom('space_blackouts')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('ends_at', '>=', new Date())
        .orderBy('starts_at')
        .execute();
    });
  }
}
