import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bookSpace } from '../src/db/bookSpace';
import { createDatabase } from '../src/db/kysely';

import { createTestFactories } from './factories';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

describe('split-space booking', () => {
  it('claims every leaf, blocks parent/child overlap, and allows siblings', async () => {
    const factory = createTestFactories(database);
    const actor = await factory.actor();
    const facilityId = newId();
    const parentId = newId();
    const leftId = newId();
    const rightId = newId();
    await factory.scoped(actor, async (trx) => {
      await trx
        .insertInto('facilities')
        .values({
          id: facilityId,
          org_id: actor.orgId,
          name: 'Fixture Park',
          ownership: 'owned',
        })
        .execute();
      for (const [id, name, parentSpaceId] of [
        [parentId, 'Full Field', null],
        [leftId, 'Left Half', parentId],
        [rightId, 'Right Half', parentId],
      ] as const) {
        await trx
          .insertInto('spaces')
          .values({
            id,
            org_id: actor.orgId,
            facility_id: facilityId,
            parent_space_id: parentSpaceId,
            name,
            kind: 'field',
          })
          .execute();
      }
    });
    const firstEvent = await factory.event(actor);
    const secondEvent = await factory.event(actor);
    const start = '2026-09-26T16:00:00Z';
    const end = '2026-09-26T17:00:00Z';
    await expect(
      factory.scoped(actor, (trx) =>
        trx
          .updateTable('spaces')
          .set({ parent_space_id: leftId })
          .where('id', '=', parentId)
          .execute(),
      ),
    ).rejects.toThrow('cycle');
    const group = await bookSpace(database, actor, {
      spaceId: parentId,
      startsAt: start,
      endsAt: end,
      eventId: firstEvent,
    });
    const claimed = await factory.scoped(actor, (trx) =>
      trx
        .selectFrom('space_bookings')
        .select('leaf_space_id')
        .where('booking_group_id', '=', group)
        .execute(),
    );
    expect(claimed.map((row) => row.leaf_space_id).sort()).toEqual(
      [leftId, rightId].sort(),
    );
    await expect(
      bookSpace(database, actor, {
        spaceId: leftId,
        startsAt: start,
        endsAt: end,
        eventId: secondEvent,
      }),
    ).rejects.toThrow();
    const thirdEvent = await factory.event(actor);
    await bookSpace(database, actor, {
      spaceId: leftId,
      startsAt: end,
      endsAt: '2026-09-26T18:00:00Z',
      eventId: thirdEvent,
    });
  });

  it('allows simultaneous bookings of separate sibling leaves', async () => {
    const factory = createTestFactories(database);
    const actor = await factory.actor();
    const facilityId = newId();
    const parentId = newId();
    const leftId = newId();
    const rightId = newId();
    await factory.scoped(actor, async (trx) => {
      await trx
        .insertInto('facilities')
        .values({
          id: facilityId,
          org_id: actor.orgId,
          name: 'Second Park',
          ownership: 'owned',
        })
        .execute();
      await trx
        .insertInto('spaces')
        .values({
          id: parentId,
          org_id: actor.orgId,
          facility_id: facilityId,
          name: 'Full Court',
          kind: 'court',
        })
        .execute();
      await trx
        .insertInto('spaces')
        .values([
          {
            id: leftId,
            org_id: actor.orgId,
            facility_id: facilityId,
            parent_space_id: parentId,
            name: 'Left',
            kind: 'court',
          },
          {
            id: rightId,
            org_id: actor.orgId,
            facility_id: facilityId,
            parent_space_id: parentId,
            name: 'Right',
            kind: 'court',
          },
        ])
        .execute();
    });
    const first = await factory.event(actor);
    const second = await factory.event(actor);
    const startsAt = '2026-09-26T16:00:00Z';
    const endsAt = '2026-09-26T17:00:00Z';
    await bookSpace(database, actor, {
      spaceId: leftId,
      startsAt,
      endsAt,
      eventId: first,
    });
    await bookSpace(database, actor, {
      spaceId: rightId,
      startsAt,
      endsAt,
      eventId: second,
    });
  });
});
