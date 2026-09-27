import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { listEventAttendance } from '../attendance/service';
import { createContest, contestDetail } from '../contests/service';
import {
  assignOfficial,
  assignmentBoard,
  confirmOfficialAssignment,
  respondToAssignment,
} from '../officials/service';
import { getStandings } from '../standings/service';
import { createBracket, getBracket } from '../tournaments/service';

let database: ReturnType<typeof createDatabase>;
type TestActor = OrgContext & { accountId: string };

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

async function createOrganization(name: string) {
  const orgId = newId();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `access-${randomUUID().slice(0, 12)}`,
      name,
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  return orgId;
}

async function createActor(orgId: string, role?: 'owner'): Promise<TestActor> {
  const accountId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `schedule-access-${accountId}@example.invalid`,
      first_name: 'Schedule',
      last_name: 'Access',
      date_of_birth: '1990-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  const context: TestActor = {
    orgId,
    accountId,
    actor: { accountId },
  };
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
    if (role)
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: accountId,
          role,
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
  });
  return context;
}

describe('schedule module access boundaries', () => {
  it('enforces tenant scope and module permissions for games and competitions', async () => {
    const orgId = await createOrganization('Schedule Access Org');
    const owner = await createActor(orgId, 'owner');
    const member = await createActor(orgId);
    const otherOrgId = await createOrganization('Other Schedule Org');
    const otherOwner = await createActor(otherOrgId, 'owner');

    const seasonId = newId();
    const sportProfileId = newId();
    const programId = newId();
    const divisionId = newId();
    const teamId = newId();
    const teamSeasonId = newId();
    const offeringId = newId();
    const template = builtInSportTemplates[0];
    await createWithOrg(database)(owner, async (trx) => {
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: 'Access Test Season',
          starts_on: '2026-01-01',
          ends_on: '2026-12-31',
        })
        .execute();
      await trx
        .insertInto('sport_profiles')
        .values({
          id: sportProfileId,
          org_id: orgId,
          name: 'Soccer',
          profile: template,
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
          name: 'Access Test Program',
          slug: `access-${randomUUID().slice(0, 12)}`,
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
        .insertInto('registration_offerings')
        .values({
          id: offeringId,
          org_id: orgId,
          program_id: programId,
          division_id: divisionId,
          name: 'Player',
          registrant_role: 'athlete',
          price_cents: 0,
        })
        .execute();
      await trx
        .insertInto('teams')
        .values({
          id: teamId,
          org_id: orgId,
          name: 'Access Test Team',
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
    });

    const eventId = newId();
    await createWithOrg(database)(owner, (trx) =>
      trx
        .insertInto('events')
        .values({
          id: eventId,
          org_id: orgId,
          program_id: programId,
          division_id: divisionId,
          kind: 'game',
          title: 'Access Test Game',
          starts_at: new Date('2026-10-10T16:00:00Z'),
          ends_at: new Date('2026-10-10T17:00:00Z'),
          timezone: 'America/Chicago',
        })
        .execute()
        .then(() => undefined),
    );
    const contest = await createContest(owner, eventId, {
      formatIndex: 0,
      stage: 'regular',
      countsForStandings: true,
    });
    const bracket = await createBracket(owner, {
      programId,
      divisionId,
      name: 'Access Test Bracket',
      type: 'single_elim',
      seedingSource: 'manual',
      entries: [{ teamSeasonId, seed: 1 }],
    });

    await expect(listEventAttendance(owner, eventId)).resolves.toBeDefined();
    await expect(contestDetail(owner, contest.id)).resolves.toBeDefined();
    await expect(getStandings(owner, { programId })).resolves.toBeDefined();
    await expect(getBracket(owner, bracket.id)).resolves.toBeDefined();
    await expect(
      assignmentBoard(owner, {
        from: new Date('2026-10-10T00:00:00Z'),
        to: new Date('2026-10-11T00:00:00Z'),
        programId,
      }),
    ).resolves.toBeDefined();

    const officialPersonId = newId();
    await createWithOrg(database)(owner, async (trx) => {
      await trx
        .insertInto('people')
        .values({
          id: officialPersonId,
          org_id: orgId,
          first_name: 'Official',
          last_name: 'Fixture',
          date_of_birth: '1990-01-01',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: orgId,
          person_id: officialPersonId,
          account_id: member.accountId,
          relationship: 'self',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('official_profiles')
        .values({
          id: newId(),
          org_id: orgId,
          person_id: officialPersonId,
          sports: [sportProfileId],
        })
        .execute();
      await trx
        .insertInto('official_positions')
        .values({
          id: newId(),
          org_id: orgId,
          sport_profile_id: sportProfileId,
          key: 'referee',
          name: 'Referee',
        })
        .execute();
    });
    const assignment = await assignOfficial(owner, {
      contestId: contest.id,
      personId: officialPersonId,
      positionKey: 'referee',
    });
    const offered = await createWithOrg(database)(owner, (trx) =>
      trx
        .selectFrom('notifications')
        .select(['type', 'payload', 'delivered_channels'])
        .where('org_id', '=', orgId)
        .where('account_id', '=', member.accountId)
        .where('type', '=', 'official_assignment.offered')
        .executeTakeFirstOrThrow(),
    );
    expect(offered.payload).toMatchObject({ assignmentId: assignment.id });
    expect(offered.delivered_channels).toEqual(['in_app']);
    const response = await respondToAssignment(
      member,
      assignment.id,
      assignment.version,
      'accepted',
    );
    const confirmed = await confirmOfficialAssignment(
      owner,
      assignment.id,
      response.version,
    );
    expect(confirmed.status).toBe('confirmed');
    const changeNotices = await createWithOrg(database)(owner, (trx) =>
      trx
        .selectFrom('notifications')
        .select(['account_id', 'payload', 'delivered_channels'])
        .where('org_id', '=', orgId)
        .where('type', '=', 'official_assignment.changed')
        .execute(),
    );
    expect(changeNotices).toHaveLength(2);
    expect(
      changeNotices.every(
        (notice) =>
          (notice.payload as { assignmentId?: string }).assignmentId ===
            assignment.id && notice.delivered_channels.includes('in_app'),
      ),
    ).toBe(true);

    await expect(listEventAttendance(member, eventId)).rejects.toMatchObject({
      status: 403,
    });
    await expect(contestDetail(member, contest.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(getStandings(member, { programId })).rejects.toMatchObject({
      status: 403,
    });
    await expect(getBracket(member, bracket.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      assignmentBoard(member, {
        from: new Date('2026-10-10T00:00:00Z'),
        to: new Date('2026-10-11T00:00:00Z'),
        programId,
      }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      listEventAttendance(otherOwner, eventId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(contestDetail(otherOwner, contest.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(getStandings(otherOwner, { programId })).rejects.toMatchObject(
      {
        status: 404,
      },
    );
    await expect(getBracket(otherOwner, bracket.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});
