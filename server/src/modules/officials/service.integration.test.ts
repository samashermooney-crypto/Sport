import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { builtInSportTemplates } from '@shared/sport/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { createContest } from '../contests/service';

import {
  assignOfficial,
  assignmentBoard,
  confirmOfficialAssignment,
  createPayBatch,
  respondToAssignment,
} from './service';

let database: ReturnType<typeof createDatabase>;
type TestActor = OrgContext & { accountId: string };

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_APP_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_APP_URL is required for officials tests.');
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
      slug: `officials-${randomUUID().slice(0, 12)}`,
      name,
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  return orgId;
}

async function createAccount(
  orgId: string,
  role?: 'owner' | 'scheduler',
): Promise<TestActor> {
  const accountId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `officials-${accountId}@example.invalid`,
      first_name: 'Officials',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  const context: TestActor = { orgId, accountId, actor: { accountId } };
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

describe('officials assignment and pay acceptance', () => {
  it('crews ten games, handles a decline and totals the pay batch', async () => {
    const orgId = await createOrganization('Officials Acceptance Org');
    const owner = await createAccount(orgId, 'owner');

    const seasonId = newId();
    const sportProfileId = newId();
    const programId = newId();
    const divisionId = newId();
    const template = builtInSportTemplates[0];
    const positions = [
      { key: 'referee', name: 'Referee' },
      { key: 'ar1', name: 'Assistant Referee 1' },
      { key: 'ar2', name: 'Assistant Referee 2' },
    ];
    const officials: Array<{ personId: string; actor: TestActor }> = [];
    const crew = [
      { key: 'referee', feeCents: 6_000 },
      { key: 'ar1', feeCents: 4_000 },
      { key: 'ar2', feeCents: 3_500 },
      { key: 'ar2', feeCents: 3_000 },
    ];
    for (const [index, member] of crew.entries()) {
      const personId = newId();
      const actor = await createAccount(orgId);
      await createWithOrg(database)(owner, async (trx) => {
        await trx
          .insertInto('people')
          .values({
            id: personId,
            org_id: orgId,
            first_name: `Official${String(index + 1)}`,
            last_name: 'Crew',
            date_of_birth: '1990-01-01',
          })
          .execute();
        await trx
          .insertInto('person_account_links')
          .values({
            id: newId(),
            org_id: orgId,
            person_id: personId,
            account_id: actor.accountId,
            relationship: 'self',
            verified_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('official_profiles')
          .values({
            id: newId(),
            org_id: orgId,
            person_id: personId,
            sports: [sportProfileId],
            pay_rates: {
              [member.key]: { feeCents: member.feeCents },
            },
          })
          .execute();
      });
      officials.push({ personId, actor });
    }
    await createWithOrg(database)(owner, async (trx) => {
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: 'Officials Season',
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
      const profileVersion = await trx
        .selectFrom('sport_profile_versions')
        .select('version')
        .where('org_id', '=', orgId)
        .where('sport_profile_id', '=', sportProfileId)
        .where('version', '=', 1)
        .executeTakeFirst();
      if (!profileVersion)
        await trx
          .insertInto('sport_profile_versions')
          .values({
            org_id: orgId,
            sport_profile_id: sportProfileId,
            version: 1,
            profile: template,
            created_by: owner.accountId,
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
          name: 'Officials Program',
          slug: `officials-${randomUUID().slice(0, 12)}`,
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
      for (const [index, position] of positions.entries())
        await trx
          .insertInto('official_positions')
          .values({
            id: newId(),
            org_id: orgId,
            sport_profile_id: sportProfileId,
            key: position.key,
            name: position.name,
            sort_order: index,
          })
          .execute();
    });

    const contestIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const eventId = newId();
      const day = index < 5 ? '2026-09-19' : '2026-09-20';
      const hour = 14 + (index % 5);
      await createWithOrg(database)(owner, (trx) =>
        trx
          .insertInto('events')
          .values({
            id: eventId,
            org_id: orgId,
            program_id: programId,
            division_id: divisionId,
            kind: 'game',
            title: `Officials Game ${String(index + 1)}`,
            starts_at: new Date(
              `${day}T${String(hour).padStart(2, '0')}:00:00Z`,
            ),
            ends_at: new Date(
              `${day}T${String(hour + 1).padStart(2, '0')}:00:00Z`,
            ),
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
      contestIds.push(contest.id);
    }

    const [referee, ar1, ar2, cover] = officials;
    if (!referee || !ar1 || !ar2 || !cover)
      throw new Error('Crew fixtures missing.');
    const mileageCents = 500;
    const assignments = new Map<string, { id: string; version: number }>();
    for (const contestId of contestIds) {
      for (const [person, positionKey] of [
        [referee.personId, 'referee'],
        [ar1.personId, 'ar1'],
        [ar2.personId, 'ar2'],
      ] as const) {
        const assignment = await assignOfficial(owner, {
          contestId,
          personId: person,
          positionKey,
          mileageCents: positionKey === 'referee' ? mileageCents : 0,
        });
        assignments.set(`${contestId}:${positionKey}`, {
          id: assignment.id,
          version: assignment.version,
        });
      }
    }

    for (const contestId of contestIds) {
      for (const [official, positionKey] of [
        [referee, 'referee'],
        [ar1, 'ar1'],
        [ar2, 'ar2'],
      ] as const) {
        const record = assignments.get(`${contestId}:${positionKey}`);
        if (!record) throw new Error('Assignment fixture missing.');
        const declined = official === ar2 && contestId === contestIds[0];
        const response = await respondToAssignment(
          official.actor,
          record.id,
          record.version,
          declined ? 'declined' : 'accepted',
        );
        expect(response.status).toBe(declined ? 'declined' : 'accepted');
        if (!declined) record.version = response.version;
      }
    }

    const declinedContest = contestIds[0];
    if (!declinedContest) throw new Error('Contest fixture missing.');
    const replacement = await assignOfficial(owner, {
      contestId: declinedContest,
      personId: cover.personId,
      positionKey: 'ar2',
      mileageCents: 0,
    });
    const replacementAccepted = await respondToAssignment(
      cover.actor,
      replacement.id,
      replacement.version,
      'accepted',
    );
    const confirmed = await confirmOfficialAssignment(
      owner,
      replacement.id,
      replacementAccepted.version,
    );
    expect(confirmed.status).toBe('confirmed');

    const board = await assignmentBoard(owner, {
      from: new Date('2026-09-19T00:00:00Z'),
      to: new Date('2026-09-21T00:00:00Z'),
      programId,
    });
    const firstGame = board.games.find(
      (game) => game.contest_id === declinedContest,
    );
    const ar2Rows = firstGame?.assignments.filter(
      (assignment) => assignment.position_key === 'ar2',
    );
    expect(ar2Rows?.map((row) => row.status).sort()).toEqual([
      'confirmed',
      'declined',
    ]);
    expect(ar2Rows?.find((row) => row.status === 'confirmed')?.person_id).toBe(
      cover.personId,
    );

    const batch = await createPayBatch(owner, {
      periodStart: '2026-09-19',
      periodEnd: '2026-09-20',
    });
    expect(batch.lines).toHaveLength(30);
    const expected =
      10 * (6_000 + mileageCents) + 10 * 4_000 + 9 * 3_500 + 3_000;
    expect(batch.totalCents).toBe(expected);
    const byPerson = new Map<string, number>();
    for (const line of batch.lines)
      byPerson.set(
        line.person_id,
        (byPerson.get(line.person_id) ?? 0) +
          (line.total_cents ?? line.fee_cents + line.mileage_cents),
      );
    expect(byPerson.get(referee.personId)).toBe(10 * 6_500);
    expect(byPerson.get(ar1.personId)).toBe(10 * 4_000);
    expect(byPerson.get(ar2.personId)).toBe(9 * 3_500);
    expect(byPerson.get(cover.personId)).toBe(3_000);
  });
});
