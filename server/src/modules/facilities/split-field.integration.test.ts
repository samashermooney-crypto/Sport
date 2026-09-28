import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { FacilitiesService, FacilityError } from './service';

let database: Kysely<DB>;
let context: OrgContext;
beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `facility-${randomUUID()}@example.invalid`,
      first_name: 'Facility',
      last_name: 'Owner',
      date_of_birth: '1980-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `facility-${randomUUID().slice(0, 12)}`,
      name: 'Split Field Test',
      kind: 'club',
      timezone: 'UTC',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        status: 'active',
        joined_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('role_assignments')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        role: 'owner',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
  });
});
afterAll(async () => {
  await database.destroy();
});

it('updates availability windows with version checks', async () => {
  const service = new FacilitiesService(database, context);
  const facility = await service.createFacility({
    name: 'Availability Park',
    ownership: 'owned',
    timezone: 'UTC',
  });
  const space = await service.createSpace({
    facilityId: facility.id,
    name: 'Court 1',
    kind: 'court',
  });
  const window = await service.addAvailability({
    spaceId: space.id,
    recurrence: {
      kind: 'weekly',
      interval: 1,
      byDay: ['MO'],
      startsOn: '2026-10-01',
      endsOn: '2026-12-31',
      exceptions: [],
      additions: [],
    },
    startTime: '17:00',
    endTime: '21:00',
    source: 'owned',
  });
  const updated = await service.updateAvailability(window.id, {
    expectedVersion: window.version,
    startTime: '18:00',
    endTime: '22:00',
  });
  expect(updated.start_time.slice(0, 5)).toBe('18:00');
  expect(updated.end_time.slice(0, 5)).toBe('22:00');
  await expect(
    service.updateAvailability(window.id, {
      expectedVersion: window.version,
      startTime: '19:00',
    }),
  ).rejects.toBeInstanceOf(FacilityError);
});

it('archives every descendant when a space is archived', async () => {
  const service = new FacilitiesService(database, context);
  const facility = await service.createFacility({
    name: 'Nested Space Park',
    ownership: 'owned',
    timezone: 'UTC',
  });
  const field = await service.createSpace({
    facilityId: facility.id,
    name: 'Field',
    kind: 'field',
  });
  const half = await service.createSpace({
    facilityId: facility.id,
    parentSpaceId: field.id,
    name: 'North half',
    kind: 'field',
  });
  const quarter = await service.createSpace({
    facilityId: facility.id,
    parentSpaceId: half.id,
    name: 'North east quarter',
    kind: 'field',
  });

  await service.archiveSpace(field.id, field.version);
  const listing = await service.list();
  expect(
    listing.spaces.filter((space) =>
      [field.id, half.id, quarter.id].includes(space.id),
    ),
  ).toHaveLength(0);
});

it('protects the space hierarchy when creating parents with future bookings', async () => {
  const service = new FacilitiesService(database, context);
  const facility = await service.createFacility({
    name: 'Booked Field Park',
    ownership: 'owned',
    timezone: 'UTC',
  });
  const parent = await service.createSpace({
    facilityId: facility.id,
    name: 'Booked Field',
    kind: 'field',
  });
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  await createWithOrg(database)(context, async (trx) => {
    const eventId = newId();
    await trx
      .insertInto('events')
      .values({
        id: eventId,
        org_id: context.orgId,
        kind: 'practice',
        title: 'Future field booking',
        starts_at: start,
        ends_at: end,
        timezone: 'UTC',
        space_id: parent.id,
      })
      .execute();
    await trx
      .insertInto('space_bookings')
      .values({
        id: newId(),
        org_id: context.orgId,
        booking_group_id: newId(),
        leaf_space_id: parent.id,
        during: `["${start.toISOString()}","${end.toISOString()}")`,
        event_id: eventId,
      })
      .execute();
  });

  await expect(
    service.createSpace({
      facilityId: facility.id,
      parentSpaceId: parent.id,
      name: 'New half field',
      kind: 'field',
    }),
  ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
});

it('rejects space hierarchy cycles and unsafe facility map URLs', async () => {
  const service = new FacilitiesService(database, context);
  const facility = await service.createFacility({
    name: 'Hierarchy Park',
    ownership: 'owned',
    timezone: 'UTC',
  });
  const parent = await service.createSpace({
    facilityId: facility.id,
    name: 'Whole field',
    kind: 'field',
  });
  const child = await service.createSpace({
    facilityId: facility.id,
    parentSpaceId: parent.id,
    name: 'North half',
    kind: 'field',
  });

  await expect(
    service.updateSpace(parent.id, {
      parentSpaceId: child.id,
      expectedVersion: parent.version,
    }),
  ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  expect(() =>
    service.createFacility({
      name: 'Unsafe map',
      ownership: 'owned',
      timezone: 'UTC',
      mapUrl: 'javascript:alert(1)',
    }),
  ).toThrow();
});

it('blocks a full-field booking over a booked half', async () => {
  const service = new FacilitiesService(database, context);
  const facility = await service.createFacility({
    name: 'Halfway Park',
    ownership: 'permitted',
    timezone: 'UTC',
  });
  const full = await service.createSpace({
    facilityId: facility.id,
    name: 'Field 2',
    kind: 'field',
  });
  const left = await service.createSpace({
    facilityId: facility.id,
    parentSpaceId: full.id,
    name: 'Field 2A',
    kind: 'field',
  });
  const right = await service.createSpace({
    facilityId: facility.id,
    parentSpaceId: full.id,
    name: 'Field 2B',
    kind: 'field',
  });
  await createWithOrg(database)(context, async (trx) => {
    const eventId = newId();
    await trx
      .insertInto('events')
      .values({
        id: eventId,
        org_id: context.orgId,
        kind: 'practice',
        title: 'Half field first',
        starts_at: new Date('2027-05-01T10:00:00Z'),
        ends_at: new Date('2027-05-01T12:00:00Z'),
        timezone: 'UTC',
        space_id: left.id,
      })
      .execute();
    await trx
      .insertInto('space_bookings')
      .values({
        id: newId(),
        org_id: context.orgId,
        booking_group_id: newId(),
        leaf_space_id: left.id,
        during: '["2027-05-01 10:00:00+00","2027-05-01 12:00:00+00")',
        event_id: eventId,
      })
      .execute();
  });
  await expect(
    createWithOrg(database)(context, async (trx) => {
      const eventId = newId();
      await trx
        .insertInto('events')
        .values({
          id: eventId,
          org_id: context.orgId,
          kind: 'practice',
          title: 'Full field over half',
          starts_at: new Date('2027-05-01T11:00:00Z'),
          ends_at: new Date('2027-05-01T13:00:00Z'),
          timezone: 'UTC',
          space_id: full.id,
        })
        .execute();
      await trx
        .insertInto('space_bookings')
        .values(
          [left, right].map((space) => ({
            id: newId(),
            org_id: context.orgId,
            booking_group_id: newId(),
            leaf_space_id: space.id,
            during: '["2027-05-01 11:00:00+00","2027-05-01 13:00:00+00")',
            event_id: eventId,
          })),
        )
        .execute();
    }),
  ).rejects.toThrow();
});

it('blocks overlapping full-field and half-field bookings through leaf exclusion', async () => {
  const service = new FacilitiesService(database, context);
  const facility = await service.createFacility({
    name: 'Riverside',
    ownership: 'owned',
    timezone: 'UTC',
  });
  const full = await service.createSpace({
    facilityId: facility.id,
    name: 'Field 1',
    kind: 'field',
  });
  const left = await service.createSpace({
    facilityId: facility.id,
    parentSpaceId: full.id,
    name: 'Field 1A',
    kind: 'field',
  });
  const right = await service.createSpace({
    facilityId: facility.id,
    parentSpaceId: full.id,
    name: 'Field 1B',
    kind: 'field',
  });
  const start = new Date('2027-04-03T10:00:00Z');
  const end = new Date('2027-04-03T12:00:00Z');
  await createWithOrg(database)(context, async (trx) => {
    const eventId = newId();
    const group = newId();
    await trx
      .insertInto('events')
      .values({
        id: eventId,
        org_id: context.orgId,
        kind: 'practice',
        title: 'Full field',
        starts_at: start,
        ends_at: end,
        timezone: 'UTC',
        space_id: full.id,
      })
      .execute();
    await trx
      .insertInto('space_bookings')
      .values(
        [left, right].map((space) => ({
          id: newId(),
          org_id: context.orgId,
          booking_group_id: group,
          leaf_space_id: space.id,
          during: '["2027-04-03 10:00:00+00","2027-04-03 12:00:00+00")',
          event_id: eventId,
        })),
      )
      .execute();
  });
  await expect(
    createWithOrg(database)(context, async (trx) => {
      const eventId = newId();
      await trx
        .insertInto('events')
        .values({
          id: eventId,
          org_id: context.orgId,
          kind: 'practice',
          title: 'Half field',
          starts_at: new Date('2027-04-03T11:00:00Z'),
          ends_at: new Date('2027-04-03T13:00:00Z'),
          timezone: 'UTC',
          space_id: left.id,
        })
        .execute();
      await trx
        .insertInto('space_bookings')
        .values({
          id: newId(),
          org_id: context.orgId,
          booking_group_id: newId(),
          leaf_space_id: left.id,
          during: '["2027-04-03 11:00:00+00","2027-04-03 13:00:00+00")',
          event_id: eventId,
        })
        .execute();
    }),
  ).rejects.toThrow();
});
