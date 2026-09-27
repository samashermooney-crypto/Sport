import { newId } from '@shared/ids';
import { recurrenceSchema } from '@shared/recurrence';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg';
import { requireStaff } from '../people/repo';

export const facilityInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  ownership: z.enum(['owned', 'permitted', 'partner']),
  address: z.record(z.string(), z.string()).nullable().default(null),
  timezone: z.string().nullable().default(null),
  parkingNotes: z.string().max(4000).nullable().default(null),
  mapUrl: z
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
    .nullable()
    .default(null),
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
export const availabilityUpdateSchema = z.strictObject({
  recurrence: recurrenceSchema.optional(),
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  endTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  source: z.enum(['owned', 'permit']).optional(),
  permitReference: z.string().max(200).nullable().optional(),
  costPerHourCents: z.number().int().nonnegative().nullable().optional(),
  expectedVersion: z.number().int().positive(),
});
export const blackoutInputSchema = z.strictObject({
  spaceId: z.uuid().nullable().default(null),
  facilityId: z.uuid().nullable().default(null),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
});
export const spaceUpdateSchema = spaceInputSchema
  .omit({ facilityId: true })
  .partial()
  .extend({ expectedVersion: z.number().int().positive() });
export class FacilityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const day = (value: string) => value;

export class FacilitiesService {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }
  private async assertNoFutureBooking(trx: OrgTransaction, spaceId: string) {
    const booking = await trx
      .selectFrom('space_bookings')
      .select('id')
      .where('org_id', '=', this.context.orgId)
      .where('leaf_space_id', '=', spaceId)
      .where(
        sql<boolean>`during && tstzrange(now(), 'infinity'::timestamptz, '[)')`,
      )
      .executeTakeFirst();
    if (booking)
      throw new FacilityError(
        409,
        'CONFLICT',
        'Move or cancel future bookings before adding child spaces',
      );
  }
  private async assertAcyclicParent(
    trx: OrgTransaction,
    spaceId: string,
    parentSpaceId: string,
    facilityId: string,
  ) {
    const spaces = await trx
      .selectFrom('spaces')
      .select(['id', 'parent_space_id'])
      .where('org_id', '=', this.context.orgId)
      .where('facility_id', '=', facilityId)
      .where('archived_at', 'is', null)
      .execute();
    const parents = new Map(
      spaces.map((space) => [space.id, space.parent_space_id]),
    );
    const visited = new Set<string>();
    let ancestor: string | null | undefined = parentSpaceId;
    while (ancestor) {
      if (ancestor === spaceId || visited.has(ancestor))
        throw new FacilityError(
          400,
          'VALIDATION_ERROR',
          'Space hierarchy cannot contain a cycle',
        );
      visited.add(ancestor);
      ancestor = parents.get(ancestor);
    }
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
          .forUpdate()
          .executeTakeFirst();
        if (!parent)
          throw new FacilityError(
            400,
            'VALIDATION_ERROR',
            'Parent space must be in the same facility',
          );
        await this.assertNoFutureBooking(trx, parent.id);
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
  updateSpace(id: string, input: z.input<typeof spaceUpdateSchema>) {
    const value = spaceUpdateSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('spaces')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .where('archived_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new FacilityError(404, 'NOT_FOUND', 'Space not found');
      if (current.version !== value.expectedVersion)
        throw new FacilityError(
          409,
          'VERSION_CONFLICT',
          'Space changed; reload before saving',
        );
      if (
        value.parentSpaceId &&
        value.parentSpaceId !== current.parent_space_id
      ) {
        if (value.parentSpaceId === id)
          throw new FacilityError(
            400,
            'VALIDATION_ERROR',
            'A space cannot be its own parent',
          );
        const parent = await trx
          .selectFrom('spaces')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('facility_id', '=', current.facility_id)
          .where('id', '=', value.parentSpaceId)
          .where('archived_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!parent)
          throw new FacilityError(
            400,
            'VALIDATION_ERROR',
            'Parent space must be in the same facility',
          );
        await this.assertAcyclicParent(trx, id, parent.id, current.facility_id);
        await this.assertNoFutureBooking(trx, parent.id);
      }
      return trx
        .updateTable('spaces')
        .set({
          ...(value.parentSpaceId === undefined
            ? {}
            : { parent_space_id: value.parentSpaceId }),
          ...(value.name === undefined ? {} : { name: value.name }),
          ...(value.kind === undefined ? {} : { kind: value.kind }),
          ...(value.surface === undefined ? {} : { surface: value.surface }),
          ...(value.hasLights === undefined
            ? {}
            : { has_lights: value.hasLights }),
          ...(value.suitability === undefined
            ? {}
            : { suitability: value.suitability as Json }),
          ...(value.capacityPeople === undefined
            ? {}
            : { capacity_people: value.capacityPeople }),
          version: current.version + 1,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  archiveFacility(id: string, expectedVersion: number) {
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
      const now = new Date();
      await trx
        .updateTable('spaces')
        .set({ archived_at: now })
        .where('org_id', '=', this.context.orgId)
        .where('facility_id', '=', id)
        .where('archived_at', 'is', null)
        .execute();
      return trx
        .updateTable('facilities')
        .set({ archived_at: now, version: current.version + 1 })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  archiveSpace(id: string, expectedVersion: number) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('spaces')
        .select(['version', 'facility_id'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .where('archived_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new FacilityError(404, 'NOT_FOUND', 'Space not found');
      if (current.version !== expectedVersion)
        throw new FacilityError(
          409,
          'VERSION_CONFLICT',
          'Space changed; reload before saving',
        );
      const now = new Date();
      const spaces = await trx
        .selectFrom('spaces')
        .select(['id', 'parent_space_id'])
        .where('org_id', '=', this.context.orgId)
        .where('facility_id', '=', current.facility_id)
        .where('archived_at', 'is', null)
        .execute();
      const children = new Map<string, string[]>();
      for (const space of spaces) {
        if (!space.parent_space_id) continue;
        const siblings = children.get(space.parent_space_id) ?? [];
        siblings.push(space.id);
        children.set(space.parent_space_id, siblings);
      }
      const descendants: string[] = [];
      const pending = [id];
      while (pending.length) {
        const parentId = pending.pop();
        if (!parentId) continue;
        for (const childId of children.get(parentId) ?? []) {
          descendants.push(childId);
          pending.push(childId);
        }
      }
      if (descendants.length)
        await trx
          .updateTable('spaces')
          .set({ archived_at: now, version: sql<number>`version + 1` })
          .where('org_id', '=', this.context.orgId)
          .where('id', 'in', descendants)
          .where('archived_at', 'is', null)
          .execute();
      return trx
        .updateTable('spaces')
        .set({ archived_at: now, version: current.version + 1 })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  deleteAvailability(id: string, expectedVersion: number) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('space_availability')
        .select('version')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new FacilityError(
          404,
          'NOT_FOUND',
          'Availability window not found',
        );
      if (current.version !== expectedVersion)
        throw new FacilityError(
          409,
          'VERSION_CONFLICT',
          'Availability window changed; reload before saving',
        );
      await trx
        .deleteFrom('space_availability')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .execute();
      return { id };
    });
  }
  updateAvailability(
    id: string,
    input: z.input<typeof availabilityUpdateSchema>,
  ) {
    const value = availabilityUpdateSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('space_availability')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new FacilityError(
          404,
          'NOT_FOUND',
          'Availability window not found',
        );
      if (current.version !== value.expectedVersion)
        throw new FacilityError(
          409,
          'VERSION_CONFLICT',
          'Availability window changed; reload before saving',
        );
      const recurrence =
        value.recurrence ?? recurrenceSchema.parse(current.recurrence);
      const startTime = value.startTime ?? current.start_time.slice(0, 5);
      const endTime = value.endTime ?? current.end_time.slice(0, 5);
      if (
        recurrence.kind === 'once' ||
        startTime >= endTime ||
        recurrence.startsOn > (recurrence.endsOn ?? '2099-12-31')
      )
        throw new FacilityError(
          400,
          'VALIDATION_ERROR',
          'Choose a recurring window with a valid date and time range',
        );
      return trx
        .updateTable('space_availability')
        .set({
          recurrence: recurrence as Json,
          starts_on: day(recurrence.startsOn),
          ends_on: day(recurrence.endsOn ?? '2099-12-31'),
          start_time: startTime,
          end_time: endTime,
          ...(value.source === undefined ? {} : { source: value.source }),
          ...(value.permitReference === undefined
            ? {}
            : { permit_reference: value.permitReference }),
          ...(value.costPerHourCents === undefined
            ? {}
            : { cost_per_hour_cents: value.costPerHourCents }),
          version: current.version + 1,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  deleteBlackout(id: string) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const removed = await trx
        .deleteFrom('space_blackouts')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .returning('id')
        .executeTakeFirst();
      if (!removed)
        throw new FacilityError(404, 'NOT_FOUND', 'Blackout not found');
      return removed;
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
