import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { FacilitiesService } from './service';

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
