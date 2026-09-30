import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { VersionConflictError } from '../../lib/version-check';

import {
  createEvent,
  createEventSeries,
  createFacility,
  createSpace,
  editEventSeries,
  getEvent,
  listEvents,
  listFacilities,
  listSpaces,
  publishEvent,
  publicFacilityPage,
  SchedulingRuleError,
  updateEvent,
} from './events';
import { eventCreateWithOverrideSchema } from './schema';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for schedule tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});

afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

type TestActor = OrgContext & { accountId: string };

async function createActor(): Promise<TestActor> {
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `schedule-events-${randomUUID()}@example.invalid`,
      first_name: 'Schedule',
      last_name: 'Events',
      date_of_birth: '1990-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `schedule-events-${randomUUID().slice(0, 12)}`,
      name: 'Schedule Events Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  const actor: TestActor = { orgId, accountId, actor: { accountId } };
  await createWithOrg(database)(actor, async (trx) => {
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
  return actor;
}

function eventInput(
  overrides: Partial<{
    title: string;
    startsAt: string;
    endsAt: string;
    spaceId: string | null;
    published: boolean;
    notesHtml: string | null;
  }> = {},
) {
  return eventCreateWithOverrideSchema.parse({
    kind: 'practice',
    title: 'Weeknight practice',
    startsAt: '2026-10-05T23:00:00.000Z',
    endsAt: '2026-10-06T00:00:00.000Z',
    ...overrides,
  });
}

describe('schedule event service', () => {
  it('creates drafts, filters their visibility, escapes notes, and publishes with version checks', async () => {
    const actor = await createActor();
    const created = await createEvent(
      actor,
      eventInput({ notesHtml: '<b>Bring & water</b>' }),
    );

    expect(created).toMatchObject({
      orgId: actor.orgId,
      title: 'Weeknight practice',
      published: false,
      notesHtml: '&lt;b&gt;Bring &amp; water&lt;/b&gt;',
      timezone: 'America/Chicago',
      version: 1,
    });
    const range = {
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-15T00:00:00.000Z'),
    };
    await expect(listEvents(actor, range)).resolves.toEqual([]);
    await expect(
      listEvents(actor, { ...range, includeDrafts: true }),
    ).resolves.toHaveLength(1);
    await expect(getEvent(actor, created.id)).resolves.toMatchObject({
      id: created.id,
      title: 'Weeknight practice',
    });

    const updated = await updateEvent(actor, created.id, {
      expectedVersion: 1,
      title: 'Updated practice',
      notesHtml: null,
    });
    expect(updated).toMatchObject({
      title: 'Updated practice',
      notesHtml: null,
      version: 2,
    });
    await expect(
      updateEvent(actor, created.id, { expectedVersion: 1, title: 'Stale' }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    const published = await publishEvent(actor, created.id, 2);
    expect(published).toMatchObject({ published: true, version: 3 });
    await expect(publishEvent(actor, created.id, 2)).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    await expect(listEvents(actor, range)).resolves.toHaveLength(1);
  });

  it('books the leaf of a nested space, rejects overlaps, and permits an adjacent slot', async () => {
    const actor = await createActor();
    const facility = await createFacility(actor, {
      name: 'North Park',
      address: null,
      timezone: 'America/Chicago',
      ownership: 'owned',
      isPublic: true,
    });
    await expect(
      createFacility(actor, {
        name: 'Unverified asset facility',
        address: null,
        timezone: 'America/Chicago',
        ownership: 'owned',
        layoutImageFileId: newId(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    const parent = await createSpace(actor, {
      facilityId: facility.id,
      name: 'Soccer complex',
      kind: 'other',
    });
    const leaf = await createSpace(actor, {
      facilityId: facility.id,
      parentSpaceId: parent.id,
      name: 'Field 1',
      kind: 'field',
      hasLights: true,
    });
    expect((await listFacilities(actor)).items).toHaveLength(1);
    await expect(listSpaces(actor, facility.id)).resolves.toHaveLength(2);

    const first = await createEvent(actor, eventInput({ spaceId: parent.id }));
    const booking = await createWithOrg(database)(actor, async (trx) =>
      trx
        .selectFrom('space_bookings')
        .select(['leaf_space_id', 'event_id'])
        .where('org_id', '=', actor.orgId)
        .where('event_id', '=', first.id)
        .executeTakeFirstOrThrow(),
    );
    expect(booking).toEqual({ leaf_space_id: leaf.id, event_id: first.id });

    await expect(
      createEvent(
        actor,
        eventInput({
          title: 'Overlapping field use',
          spaceId: leaf.id,
          startsAt: '2026-10-05T23:30:00.000Z',
          endsAt: '2026-10-06T00:30:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'SCHEDULE_CONFLICT',
      details: { conflicts: [expect.objectContaining({ kind: 'space' })] },
    });

    await expect(
      createEvent(
        actor,
        eventInput({
          title: 'Next field use',
          spaceId: leaf.id,
          startsAt: '2026-10-06T00:00:00.000Z',
          endsAt: '2026-10-06T01:00:00.000Z',
        }),
      ),
    ).resolves.toMatchObject({ title: 'Next field use' });
    await expect(
      createSpace(actor, {
        facilityId: facility.id,
        parentSpaceId: leaf.id,
        name: 'New subfield',
        kind: 'field',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'SCHEDULE_CONFLICT' });
    const publicEvent = await createEvent(
      actor,
      eventInput({
        title: 'Public field event',
        spaceId: leaf.id,
        startsAt: '2026-10-06T01:00:00.000Z',
        endsAt: '2026-10-06T02:00:00.000Z',
        published: true,
      }),
    );
    const slug = await createWithOrg(database)(actor, async (trx) =>
      trx
        .selectFrom('organizations')
        .select('slug')
        .where('id', '=', actor.orgId)
        .executeTakeFirstOrThrow(),
    );
    const page = await publicFacilityPage(slug.slug, facility.id);
    expect(page.facility.id).toBe(facility.id);
    expect(page.spaces.map((space) => space.id)).toEqual(
      expect.arrayContaining([parent.id, leaf.id]),
    );
    expect(page.events.map((event) => event.id)).toEqual([publicEvent.id]);
    expect(page.organizationTimezone).toBe('America/Chicago');
    await expect(
      createEvent(actor, eventInput({ startsAt: '2026-10-06T00:00:00.000Z' })),
    ).rejects.toBeInstanceOf(SchedulingRuleError);
  });

  it('materializes a one-time series and detaches an edited occurrence', async () => {
    const actor = await createActor();
    const series = await createEventSeries(actor, {
      recurrence: { kind: 'once', date: '2026-10-05' },
      startTime: '18:00',
      durationMinutes: 60,
      timezone: 'America/Chicago',
      template: eventInput(),
    });
    expect(series.eventIds).toHaveLength(1);
    const eventId = series.eventIds.at(0);
    if (!eventId) throw new Error('Expected one materialized series event.');
    const original = await createWithOrg(database)(actor, async (trx) =>
      trx
        .selectFrom('events')
        .select(['id', 'starts_at', 'series_id'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow(),
    );
    expect(original.series_id).toBe(series.seriesId);

    await expect(
      editEventSeries(actor, series.seriesId, {
        scope: 'this',
        occurrenceStartsAt: original.starts_at.toISOString(),
        expectedVersion: 1,
        template: { title: 'One time clinic' },
      }),
    ).resolves.toEqual({ eventIds: [original.id], seriesId: null });
    await expect(getEvent(actor, original.id)).resolves.toMatchObject({
      title: 'One time clinic',
      startsAt: original.starts_at.toISOString(),
    });
    const detached = await createWithOrg(database)(actor, async (trx) =>
      trx
        .selectFrom('events')
        .select('series_id')
        .where('org_id', '=', actor.orgId)
        .where('id', '=', original.id)
        .executeTakeFirstOrThrow(),
    );
    expect(detached.series_id).toBeNull();
  });
});
