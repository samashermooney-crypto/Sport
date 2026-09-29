import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import {
  createCalendarFeed,
  getCalendarFeed,
  listCalendarFeeds,
  revokeCalendarFeed,
} from './events';

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
      email: `calendar-feed-${randomUUID()}@example.invalid`,
      first_name: 'Calendar',
      last_name: 'Feed',
      date_of_birth: '1990-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `calendar-feed-${randomUUID().slice(0, 12)}`,
      name: 'Calendar Feed Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  const actor = { orgId, accountId, actor: { accountId } };
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

async function createTeam(actor: TestActor): Promise<string> {
  const seasonId = newId();
  const sportProfileId = newId();
  const programId = newId();
  const divisionId = newId();
  const teamId = newId();
  const teamSeasonId = newId();
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .insertInto('seasons')
      .values({
        id: seasonId,
        org_id: actor.orgId,
        name: 'Calendar Feed Season',
        starts_on: '2026-01-01',
        ends_on: '2026-12-31',
      })
      .execute();
    await trx
      .insertInto('sport_profiles')
      .values({
        id: sportProfileId,
        org_id: actor.orgId,
        name: 'Calendar Feed Sport',
        profile: builtInSportTemplates[0],
      })
      .execute();
    await trx
      .insertInto('programs')
      .values({
        id: programId,
        org_id: actor.orgId,
        season_id: seasonId,
        sport_profile_id: sportProfileId,
        mode: 'league',
        name: 'Calendar Feed Program',
        slug: `calendar-feed-${randomUUID().slice(0, 12)}`,
        starts_on: '2026-03-01',
        ends_on: '2026-11-30',
      })
      .execute();
    await trx
      .insertInto('divisions')
      .values({
        id: divisionId,
        org_id: actor.orgId,
        program_id: programId,
        name: 'Open',
        level: 'open',
      })
      .execute();
    await trx
      .insertInto('teams')
      .values({
        id: teamId,
        org_id: actor.orgId,
        name: 'Calendar Feed Team',
        sport_profile_id: sportProfileId,
      })
      .execute();
    await trx
      .insertInto('team_seasons')
      .values({
        id: teamSeasonId,
        org_id: actor.orgId,
        team_id: teamId,
        program_id: programId,
        division_id: divisionId,
      })
      .execute();
  });
  return teamSeasonId;
}

describe('tokenized schedule calendar feeds', () => {
  it('serves facility events, lists and revokes the private URL', async () => {
    const actor = await createActor();
    const outsider = await createActor();
    const facilityId = newId();
    const spaceId = newId();
    const eventId = newId();
    const startsAt = new Date('2026-10-10T16:00:00.000Z');

    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .insertInto('facilities')
        .values({
          id: facilityId,
          org_id: actor.orgId,
          name: 'Calendar Feed Park',
          ownership: 'owned',
          timezone: 'America/Chicago',
        })
        .execute();
      await trx
        .insertInto('spaces')
        .values({
          id: spaceId,
          org_id: actor.orgId,
          facility_id: facilityId,
          name: 'Calendar Feed Field',
          kind: 'field',
        })
        .execute();
      await trx
        .insertInto('events')
        .values({
          id: eventId,
          org_id: actor.orgId,
          kind: 'game',
          title: 'Facility feed acceptance game',
          starts_at: startsAt,
          ends_at: new Date(startsAt.getTime() + 60 * 60 * 1000),
          timezone: 'America/Chicago',
          space_id: spaceId,
          published: true,
        })
        .execute();
      const privatePersonId = newId();
      const privateEventId = newId();
      await trx
        .insertInto('people')
        .values({
          id: privatePersonId,
          org_id: actor.orgId,
          first_name: 'Unverified',
          last_name: 'Athlete',
          date_of_birth: '2012-01-01',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: actor.orgId,
          person_id: privatePersonId,
          account_id: actor.accountId,
          relationship: 'guardian',
        })
        .execute();
      await trx
        .insertInto('events')
        .values({
          id: privateEventId,
          org_id: actor.orgId,
          kind: 'practice',
          title: 'Unverified-linked private event',
          starts_at: startsAt,
          ends_at: new Date(startsAt.getTime() + 60 * 60 * 1000),
          timezone: 'America/Chicago',
          published: true,
        })
        .execute();
      await trx
        .insertInto('event_participants')
        .values({
          id: newId(),
          org_id: actor.orgId,
          event_id: privateEventId,
          person_id: privatePersonId,
        })
        .execute();
    });

    const feed = await createCalendarFeed(actor, {
      type: 'facility',
      id: facilityId,
    });
    const token = feed.url
      .split('/')
      .at(-1)
      ?.replace(/\.ics$/, '');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(feed.url).toContain(`/orgs/${actor.orgId}/feeds/`);

    const storedHash = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('calendar_feeds')
        .select('token_hash')
        .where('org_id', '=', actor.orgId)
        .where('id', '=', feed.id)
        .executeTakeFirstOrThrow(),
    );
    expect(Buffer.from(storedHash.token_hash).toString('base64url')).not.toBe(
      token,
    );

    const calendar = await getCalendarFeed(actor, token ?? '');
    expect(calendar).toContain('SUMMARY:Facility feed acceptance game');
    expect(
      await listCalendarFeeds(actor, { type: 'facility', id: facilityId }),
    ).toMatchObject({ items: [{ id: feed.id }] });

    await revokeCalendarFeed(actor, feed.id);
    expect(
      await listCalendarFeeds(actor, { type: 'facility', id: facilityId }),
    ).toEqual({ items: [] });
    const accountFeed = await createCalendarFeed(actor, { type: 'account' });
    const accountToken = accountFeed.url
      .split('/')
      .at(-1)
      ?.replace(/\.ics$/, '');
    expect(await getCalendarFeed(actor, accountToken ?? '')).not.toContain(
      'SUMMARY:Unverified-linked private event',
    );
    await expect(
      revokeCalendarFeed(outsider, accountFeed.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(getCalendarFeed(actor, token ?? '')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('allows read-scoped team schedules but prevents cross-account feed revocation', async () => {
    const actor = await createActor();
    const teamSeasonId = await createTeam(actor);
    const outsider = await createActor();
    const facilityId = newId();

    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ revoked_at: new Date() })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .where('role', '=', 'owner')
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: actor.orgId,
          account_id: actor.accountId,
          role: 'reporter',
          scope_type: 'team_season',
          scope_id: teamSeasonId,
          pending_mfa: false,
        })
        .execute();
      await trx
        .insertInto('facilities')
        .values({
          id: facilityId,
          org_id: actor.orgId,
          name: 'Restricted calendar facility',
          ownership: 'owned',
          timezone: 'America/Chicago',
        })
        .execute();
    });

    const teamFeed = await createCalendarFeed(actor, {
      type: 'team',
      id: teamSeasonId,
    });
    await expect(
      createCalendarFeed(actor, { type: 'facility', id: facilityId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      revokeCalendarFeed(outsider, teamFeed.id),
    ).rejects.toMatchObject({ status: 404 });
  });
});
