import { newId } from '@shared/ids';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import type { DB } from './types';
import { createWithOrg } from './withOrg';
import type { OrgContext } from './withOrg';

export interface SpaceBookingInput {
  spaceId: string;
  startsAt: string;
  endsAt: string;
  eventId?: string;
  allocationId?: string;
}

export async function bookSpace(
  database: Kysely<DB>,
  context: OrgContext,
  input: SpaceBookingInput,
): Promise<string> {
  if ((input.eventId === undefined) === (input.allocationId === undefined)) {
    throw new Error('Exactly one event or allocation is required');
  }
  if (new Date(input.startsAt).getTime() >= new Date(input.endsAt).getTime()) {
    throw new Error('Booking end must follow start');
  }
  const bookingGroupId = newId();
  await createWithOrg(database)(context, async (trx) => {
    const leaves = await sql<{ id: string }>`
      WITH RECURSIVE descendants AS (
        SELECT id FROM spaces WHERE org_id = ${context.orgId} AND id = ${input.spaceId}
        UNION ALL
        SELECT child.id FROM spaces child
        JOIN descendants parent ON child.parent_space_id = parent.id
        WHERE child.org_id = ${context.orgId}
      )
      SELECT d.id FROM descendants d
      WHERE NOT EXISTS (
        SELECT 1 FROM spaces child WHERE child.org_id = ${context.orgId} AND child.parent_space_id = d.id
      )
    `.execute(trx);
    if (leaves.rows.length === 0) {
      throw new Error('Space does not exist in this organization');
    }
    for (const leaf of leaves.rows) {
      await trx
        .insertInto('space_bookings')
        .values({
          id: newId(),
          org_id: context.orgId,
          booking_group_id: bookingGroupId,
          leaf_space_id: leaf.id,
          during: sql`tstzrange(${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, '[)')`,
          event_id: input.eventId ?? null,
          allocation_id: input.allocationId ?? null,
        })
        .execute();
    }
  });
  return bookingGroupId;
}
