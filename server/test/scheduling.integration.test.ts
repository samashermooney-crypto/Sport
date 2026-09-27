import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../src/db/kysely';
import type { OrgContext } from '../src/db/withOrg';
import { createWithOrg } from '../src/db/withOrg';
import { ScheduleAccessError } from '../src/modules/scheduling/access';
import {
  createEvent,
  createEventSeries,
  createCalendarFeed,
  editEventSeries,
  getCalendarFeed,
  getEvent,
  updateEvent,
} from '../src/modules/scheduling/events';
import { emitPendingScheduleBatches } from '../src/modules/scheduling/generator';
import {
  createClosure,
  previewClosure,
} from '../src/modules/scheduling/operations';

import type { ActorFixture } from './factories';
import { createTestFactories } from './factories';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error(
      'TEST_DATABASE_APP_URL is required for scheduling integration tests.',
    );
  // Service functions use the application singleton; point it at the per-suite test database.
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});
afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

async function actorWithManager(): Promise<ActorFixture> {
  const factory = createTestFactories(database);
  const actor = await factory.actor();
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .where('account_id', '=', actor.accountId)
      .execute();
  });
  return actor;
}

const seriesTemplate = (programId: string) => ({
  kind: 'practice' as const,
  title: 'Sunday practice',
  programId,
  divisionId: null,
  spaceId: null,
  locationText: 'Gym',
  notesHtml: null,
  arrivalMinutesBefore: 0,
  participants: [],
  published: false,
});

describe('schedule service tenancy, series, closures, and calendar feeds', () => {
  it('edits a recurring series across the Chicago spring-forward boundary without changing Phoenix local times', async () => {
    const factory = createTestFactories(database);
    const chicago = await actorWithManager();
    const phoenix = await actorWithManager();
    const chicagoProgram = await factory.program(chicago);
    const phoenixProgram = await factory.program(phoenix);
    await createWithOrg(database)(phoenix, async (trx) => {
      await trx
        .updateTable('organizations')
        .set({ timezone: 'America/Phoenix' })
        .where('id', '=', phoenix.orgId)
        .execute();
    });

    const createSeries = (
      context: OrgContext,
      programId: string,
      timezone: string,
    ) =>
      createEventSeries(context, {
        recurrence: {
          kind: 'weekly',
          interval: 1,
          byDay: ['SU'],
          startsOn: '2027-03-07',
          endsOn: '2027-03-28',
          exceptions: [],
          additions: [],
        },
        startTime: '02:30',
        durationMinutes: 60,
        timezone,
        template: seriesTemplate(programId),
      });
    const chicagoSeries = await createSeries(
      chicago,
      chicagoProgram.programId,
      'America/Chicago',
    );
    const phoenixSeries = await createSeries(
      phoenix,
      phoenixProgram.programId,
      'America/Phoenix',
    );
    const readTimes = async (context: OrgContext, seriesId: string) =>
      createWithOrg(database)(context, async (trx) =>
        trx
          .selectFrom('events')
          .select(['starts_at', 'title'])
          .where('org_id', '=', context.orgId)
          .where('series_id', '=', seriesId)
          .orderBy('starts_at')
          .execute(),
      );
    const chicagoBefore = await readTimes(chicago, chicagoSeries.seriesId);
    const phoenixBefore = await readTimes(phoenix, phoenixSeries.seriesId);
    expect(chicagoBefore.map((event) => event.starts_at.toISOString())).toEqual(
      [
        '2027-03-07T08:30:00.000Z',
        '2027-03-14T08:30:00.000Z',
        '2027-03-21T07:30:00.000Z',
        '2027-03-28T07:30:00.000Z',
      ],
    );
    expect(phoenixBefore.map((event) => event.starts_at.toISOString())).toEqual(
      [
        '2027-03-07T09:30:00.000Z',
        '2027-03-14T09:30:00.000Z',
        '2027-03-21T09:30:00.000Z',
        '2027-03-28T09:30:00.000Z',
      ],
    );

    const edited = await editEventSeries(chicago, chicagoSeries.seriesId, {
      scope: 'following',
      occurrenceStartsAt: '2027-03-14T08:30:00.000Z',
      expectedVersion: 1,
      recurrence: {
        timezone: 'America/Chicago',
        startTime: '03:00',
        durationMinutes: 60,
        recurrence: {
          kind: 'weekly',
          interval: 1,
          byDay: ['SU'],
          startsOn: '2027-03-14',
          endsOn: '2027-03-28',
          exceptions: [],
          additions: [],
        },
      },
    });
    const replacementSeriesId = edited.seriesId;
    if (!replacementSeriesId)
      throw new Error('The following-series edit did not create a new series.');
    const priorEvents = await readTimes(chicago, chicagoSeries.seriesId);
    const replacementEvents = await readTimes(chicago, replacementSeriesId);
    expect(priorEvents.map((event) => event.starts_at.toISOString())).toEqual([
      '2027-03-07T08:30:00.000Z',
      '2027-03-14T08:30:00.000Z',
      '2027-03-21T07:30:00.000Z',
      '2027-03-28T07:30:00.000Z',
    ]);
    expect(
      replacementEvents.map((event) => event.starts_at.toISOString()),
    ).toEqual([
      '2027-03-14T08:00:00.000Z',
      '2027-03-21T08:00:00.000Z',
      '2027-03-28T08:00:00.000Z',
    ]);
  });

  it('previews and postpones every event inside an organization closure window', async () => {
    const factory = createTestFactories(database);
    const actor = await actorWithManager();
    const program = await factory.program(actor);
    const event = await createEvent(actor, {
      kind: 'game',
      title: 'Rainout test game',
      startsAt: '2026-10-03T15:00:00.000Z',
      endsAt: '2026-10-03T16:00:00.000Z',
      programId: program.programId,
      divisionId: program.divisionId,
      participants: [],
      published: false,
      arrivalMinutesBefore: 0,
    });
    const closure = {
      scopeType: 'org' as const,
      scopeId: null,
      startsAt: '2026-10-03T14:00:00.000Z',
      endsAt: '2026-10-03T18:00:00.000Z',
      reason: 'weather' as const,
      message: 'Weather closure',
      previewOnly: false,
    };
    await expect(previewClosure(actor, closure)).resolves.toMatchObject({
      count: 1,
      events: [{ id: event.id }],
    });
    const created = await createClosure(actor, closure);
    expect(created.affectedEventIds).toEqual([event.id]);
    const closureId = created.id;
    if (!closureId) throw new Error('The closure was not persisted.');
    await expect(getEvent(actor, event.id)).resolves.toMatchObject({
      status: 'postponed',
      statusReason: `closure:${closureId}`,
    });
  });

  it('batches published schedule changes into one Track B in-app notification', async () => {
    const factory = createTestFactories(database);
    const actor = await actorWithManager();
    const program = await factory.program(actor);
    const personId = await factory.person(actor);
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: actor.orgId,
          person_id: personId,
          account_id: actor.accountId,
          relationship: 'self',
          verified_at: new Date(),
        })
        .execute();
    });
    const createPublishedEvent = (title: string) =>
      createEvent(actor, {
        kind: 'game',
        title,
        startsAt: '2026-10-17T15:00:00.000Z',
        endsAt: '2026-10-17T16:00:00.000Z',
        programId: program.programId,
        divisionId: program.divisionId,
        participants: [{ type: 'person', id: personId, side: 'none' }],
        published: true,
        arrivalMinutesBefore: 0,
      });
    const first = await createPublishedEvent('Tournament game one');
    const second = await createPublishedEvent('Tournament game two');
    const pending = await createWithOrg(database)(actor, async (trx) => {
      const rows = await trx
        .selectFrom('schedule_change_batches')
        .selectAll()
        .where('org_id', '=', actor.orgId)
        .where('recipient_account_id', '=', actor.accountId)
        .where('status', '=', 'pending')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventId: first.id, change: 'created' }),
          expect.objectContaining({ eventId: second.id, change: 'created' }),
        ]),
      );
      await trx
        .updateTable('schedule_change_batches')
        .set({ emit_after: new Date(Date.now() - 1_000) })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', rows[0]?.id ?? '')
        .execute();
      return rows[0];
    });
    if (!pending) throw new Error('The schedule change batch was not queued.');

    await emitPendingScheduleBatches();
    const notifications = await createWithOrg(database)(actor, async (trx) =>
      trx
        .selectFrom('notifications')
        .select(['type', 'payload', 'delivered_channels'])
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .where('type', '=', 'schedule.changed')
        .execute(),
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.delivered_channels).toEqual(['in_app']);
    expect(notifications[0]?.payload).toMatchObject({
      resourceType: 'schedule_change_batch',
      resourceId: pending.id,
      href: '/me/schedule',
    });
  });

  it('keeps calendar tokens tenant-scoped and reflects a moved published game', async () => {
    const factory = createTestFactories(database);
    const owner = await actorWithManager();
    const other = await actorWithManager();
    const program = await factory.program(owner);
    const { teamSeasonId } = await factory.team(owner, program);
    const event = await createEvent(owner, {
      kind: 'game',
      title: 'Schedule feed game',
      startsAt: '2026-10-10T15:00:00.000Z',
      endsAt: '2026-10-10T16:00:00.000Z',
      programId: program.programId,
      divisionId: program.divisionId,
      participants: [{ type: 'team', id: teamSeasonId, side: 'home' }],
      published: true,
      arrivalMinutesBefore: 0,
    });
    const feed = await createCalendarFeed(owner, {
      type: 'team',
      id: teamSeasonId,
    });
    const token = /feeds\/([^/]+)\.ics$/.exec(feed.url)?.[1];
    if (!token)
      throw new Error('The tokenized feed URL did not include a token.');
    await updateEvent(owner, event.id, {
      startsAt: '2026-10-10T17:00:00.000Z',
      endsAt: '2026-10-10T18:00:00.000Z',
      expectedVersion: 1,
    });
    const ics = await getCalendarFeed(owner, token);
    expect(ics).toContain(`UID:${event.id}@athlentry`);
    expect(ics).toContain('DTSTART:20261010T170000Z');
    await expect(getCalendarFeed(other, token)).rejects.toThrow(/not found/i);
    await expect(getEvent(other, event.id)).rejects.toThrow(/not found/i);
  });

  it('denies schedule reads without a scoped role or roster relationship', async () => {
    const factory = createTestFactories(database);
    const actor = await actorWithManager();
    const eventId = await factory.event(actor);
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .deleteFrom('role_assignments')
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
    });
    await expect(getEvent(actor, eventId)).rejects.toBeInstanceOf(
      ScheduleAccessError,
    );
  });
});
