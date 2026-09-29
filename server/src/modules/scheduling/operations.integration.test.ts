import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { expand } from '@shared/recurrence';
import type { Recurrence } from '@shared/recurrence';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import {
  createAllocation,
  createClosure,
  decideAllocationRequest,
  decideRescheduleRequest,
  listAllocationRequests,
  listRescheduleRequests,
  listTeamPracticeAllocations,
  previewClosure,
  requestAllocationSlot,
  requestReschedule,
} from './operations';
import {
  createSpaceAvailability,
  createSpaceBlackout,
  createTeamBlackoutRequest,
  decideTeamBlackoutRequest,
  exportScheduleCsv,
  listSpaceAvailability,
  shiftGamesOnDate,
  updateScheduleSettings,
} from './tools';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for scheduling tests.');
  process.env.DATABASE_URL = connectionString;
  database = createDatabase(connectionString);
});

afterAll(async () => {
  await Promise.all([database.destroy(), getDatabase().destroy()]);
});

describe('schedule operations', () => {
  it('manages closures, allocations, resource tools, and reschedules', async () => {
    const accountId = newId();
    const orgId = newId();
    const actor: OrgContext & { accountId: string } = {
      orgId,
      accountId,
      actor: { accountId },
    };
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `schedule-operations-${randomUUID()}@example.invalid`,
        first_name: 'Schedule',
        last_name: 'Operations',
        date_of_birth: '1990-01-01',
        email_verified_at: new Date(),
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `schedule-ops-${randomUUID().slice(0, 12)}`,
        name: 'Schedule Operations Test',
        kind: 'club',
        timezone: 'America/Chicago',
      })
      .execute();

    const seasonId = newId();
    const sportProfileId = newId();
    const programId = newId();
    const divisionId = newId();
    const teamId = newId();
    const teamSeasonId = newId();
    const facilityId = newId();
    const spaceId = newId();
    const scoped = createWithOrg(database);
    await scoped(actor, async (trx) => {
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
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: 'Schedule Operations Season',
          starts_on: '2026-01-01',
          ends_on: '2026-12-31',
        })
        .execute();
      await trx
        .insertInto('sport_profiles')
        .values({
          id: sportProfileId,
          org_id: orgId,
          name: 'Schedule Operations Sport',
          profile: builtInSportTemplates[0],
        })
        .execute();
      await trx
        .insertInto('programs')
        .values({
          id: programId,
          org_id: orgId,
          season_id: seasonId,
          sport_profile_id: sportProfileId,
          mode: 'league',
          name: 'Schedule Operations Program',
          slug: `schedule-ops-${randomUUID().slice(0, 12)}`,
          starts_on: '2026-03-01',
          ends_on: '2026-11-30',
        })
        .execute();
      await trx
        .insertInto('divisions')
        .values({
          id: divisionId,
          org_id: orgId,
          program_id: programId,
          name: 'Open',
          level: 'open',
        })
        .execute();
      await trx
        .insertInto('teams')
        .values({
          id: teamId,
          org_id: orgId,
          name: 'Schedule Operations Team',
          sport_profile_id: sportProfileId,
        })
        .execute();
      await trx
        .insertInto('team_seasons')
        .values({
          id: teamSeasonId,
          org_id: orgId,
          team_id: teamId,
          program_id: programId,
          division_id: divisionId,
        })
        .execute();
      await trx
        .insertInto('facilities')
        .values({
          id: facilityId,
          org_id: orgId,
          name: 'Operations Test Facility',
          timezone: 'America/Chicago',
          ownership: 'owned',
        })
        .execute();
      await trx
        .insertInto('spaces')
        .values({
          id: spaceId,
          org_id: orgId,
          facility_id: facilityId,
          name: 'Operations Test Field',
          kind: 'field',
          suitability: {},
        })
        .execute();
      await trx
        .insertInto('schedule_settings')
        .values({
          id: newId(),
          org_id: orgId,
          program_id: programId,
          coach_slot_picker_enabled: true,
          slot_approval_required: true,
          version: 1,
        })
        .execute();
    });

    const startsOn = '2026-10-05';
    const endsOn = '2026-10-19';
    const recurrence: Recurrence = {
      kind: 'weekly',
      interval: 1,
      byDay: ['MO'],
      startsOn,
      endsOn,
      exceptions: [],
      additions: [],
    };
    const allocation = await createAllocation(actor, {
      spaceId,
      teamSeasonId,
      recurrence,
      startsOn,
      endsOn,
      startTime: '18:00',
      endTime: '19:00',
      timezone: 'America/Chicago',
      purpose: 'practice',
    });
    const allocatedSlot = expand(
      {
        recurrence,
        startTime: '18:00',
        durationMinutes: 60,
        timezone: 'America/Chicago',
      },
      startsOn,
      endsOn,
    )[0];
    if (!allocatedSlot) throw new Error('Expected an allocated practice slot.');
    expect(await listTeamPracticeAllocations(actor, teamSeasonId)).toHaveLength(
      1,
    );

    const slotRequest = await requestAllocationSlot(actor, allocation.id, {
      startsAt: allocatedSlot.startsAt,
      endsAt: allocatedSlot.endsAt,
    });
    expect(slotRequest.status).toBe('pending');
    expect(await listAllocationRequests(actor)).toHaveLength(1);
    const practice = await decideAllocationRequest(actor, slotRequest.id, {
      approve: true,
      expectedVersion: 1,
    });
    expect(practice.status).toBe('approved');
    expect(practice.eventId).toBeTruthy();

    const availability = await createSpaceAvailability(actor, {
      spaceId,
      recurrence,
      startsOn,
      endsOn,
      startTime: '18:00',
      endTime: '19:00',
      timezone: 'America/Chicago',
      source: 'owned',
    });
    expect(availability.space_id).toBe(spaceId);
    expect(await listSpaceAvailability(actor, spaceId)).toHaveLength(1);
    const blackout = await createSpaceBlackout(actor, {
      scopeType: 'space',
      scopeId: spaceId,
      startsAt: '2026-10-06T16:00:00.000Z',
      endsAt: '2026-10-06T17:00:00.000Z',
      reason: 'Field maintenance',
    });
    expect(blackout.space_id).toBe(spaceId);

    const teamBlackout = await createTeamBlackoutRequest(actor, teamSeasonId, {
      startsOn: '2026-10-06',
      endsOn: '2026-10-07',
      reason: 'School trip',
    });
    expect(teamBlackout.status).toBe('pending');
    await expect(
      decideTeamBlackoutRequest(actor, teamBlackout.id, {
        approve: true,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ status: 'approved', version: 2 });
    await expect(
      updateScheduleSettings(actor, {
        programId,
        coachSlotPickerEnabled: false,
        slotApprovalRequired: false,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({
      coach_slot_picker_enabled: false,
      slot_approval_required: false,
      version: 2,
    });

    const closureEventId = newId();
    await scoped(actor, (trx) =>
      trx
        .insertInto('events')
        .values({
          id: closureEventId,
          org_id: orgId,
          kind: 'practice',
          title: 'Schedule Operations Closure Event',
          starts_at: new Date('2026-09-26T16:00:00.000Z'),
          ends_at: new Date('2026-09-26T17:00:00.000Z'),
          timezone: 'America/Chicago',
        })
        .execute()
        .then(() => undefined),
    );
    const closure = {
      scopeType: 'org' as const,
      startsAt: '2026-09-26T16:30:00.000Z',
      endsAt: '2026-09-26T18:00:00.000Z',
      reason: 'weather' as const,
      previewOnly: false,
    };
    await expect(previewClosure(actor, closure)).resolves.toMatchObject({
      count: 1,
      events: [expect.objectContaining({ id: closureEventId })],
    });
    await expect(
      createClosure(actor, { ...closure, previewOnly: true }),
    ).resolves.toMatchObject({
      preview: true,
      affected: [expect.objectContaining({ id: closureEventId })],
    });
    const recordedClosure = await createClosure(actor, closure);
    const recordedClosureId = recordedClosure.id;
    if (typeof recordedClosureId !== 'string')
      throw new Error('Expected the closure to be recorded.');
    expect(recordedClosure.affectedEventIds).toEqual([closureEventId]);
    const closed = await scoped(actor, (trx) =>
      trx
        .selectFrom('events')
        .select(['status', 'status_reason'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', closureEventId)
        .executeTakeFirstOrThrow(),
    );
    expect(closed.status).toBe('postponed');
    expect(closed.status_reason).toBe(`closure:${recordedClosureId}`);

    const rescheduleEventId = newId();
    await scoped(actor, (trx) =>
      trx
        .insertInto('events')
        .values({
          id: rescheduleEventId,
          org_id: orgId,
          program_id: programId,
          division_id: divisionId,
          kind: 'game',
          title: '=Operations Game',
          starts_at: new Date('2026-10-10T16:00:00.000Z'),
          ends_at: new Date('2026-10-10T17:00:00.000Z'),
          timezone: 'America/Chicago',
          published: true,
        })
        .execute()
        .then(() => undefined),
    );
    const requestedReschedule = await requestReschedule(
      actor,
      rescheduleEventId,
      {
        reason: 'Field availability changed',
        proposedSlots: [
          {
            startsAt: '2026-10-11T16:00:00.000Z',
            endsAt: '2026-10-11T17:00:00.000Z',
          },
        ],
      },
    );
    expect(await listRescheduleRequests(actor)).toHaveLength(1);
    const decision = await decideRescheduleRequest(
      actor,
      requestedReschedule.id,
      { approve: true, slotIndex: 0, expectedVersion: 1 },
    );
    expect(decision).toMatchObject({
      status: 'approved',
      resultingEventId: rescheduleEventId,
    });
    const moved = await scoped(actor, (trx) =>
      trx
        .selectFrom('events')
        .select('starts_at')
        .where('org_id', '=', actor.orgId)
        .where('id', '=', rescheduleEventId)
        .executeTakeFirstOrThrow(),
    );
    expect(moved.starts_at.toISOString()).toBe('2026-10-11T16:00:00.000Z');

    await expect(
      shiftGamesOnDate(actor, {
        fromDate: '2026-10-11',
        toDate: '2026-10-12',
        timezone: 'America/Chicago',
      }),
    ).resolves.toMatchObject({ eventIds: [rescheduleEventId] });
    const shifted = await scoped(actor, (trx) =>
      trx
        .selectFrom('events')
        .select('starts_at')
        .where('org_id', '=', orgId)
        .where('id', '=', rescheduleEventId)
        .executeTakeFirstOrThrow(),
    );
    expect(shifted.starts_at.toISOString()).toBe('2026-10-12T16:00:00.000Z');

    const csv = await exportScheduleCsv(
      actor,
      { type: 'program', id: programId },
      {
        from: new Date('2026-10-01T00:00:00.000Z'),
        to: new Date('2026-11-01T00:00:00.000Z'),
      },
    );
    expect(csv).toContain(`${rescheduleEventId},'=Operations Game,game,`);
  });
});
