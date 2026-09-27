import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/db/kysely.js';
import { createWithOrg } from '../../src/db/withOrg.js';
import { PostgresTeamEntries } from '../../src/modules/registration/team-entries.js';
import { createTestFactories } from '../factories.js';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

describe('team entry registration', () => {
  it('registers an adult captain, invites players, opens their player checkout, and records approval', async () => {
    const factories = createTestFactories(database);
    const captain = await factories.actor();
    const fixture = await factories.program(captain);
    const captainPersonId = await factories.person(captain, {
      firstName: 'Jordan',
      lastName: 'Captain',
      dateOfBirth: '1980-01-01',
    });
    const playerAccountId = newId();
    const playerPersonId = await factories.person(captain, {
      firstName: 'Alex',
      lastName: 'Player',
      dateOfBirth: '1990-02-02',
    });
    const playerHouseholdId = await factories.household(captain);
    const playerEmail = `team-player-${randomUUID()}@example.invalid`;
    const teamOfferingId = newId();

    await database
      .insertInto('accounts')
      .values({
        id: playerAccountId,
        email: playerEmail,
        first_name: 'Alex',
        last_name: 'Player',
        date_of_birth: '1990-02-02',
        email_verified_at: new Date(),
      })
      .execute();
    await createWithOrg(database)(captain, async (trx) => {
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', captain.orgId)
        .where('account_id', '=', captain.accountId)
        .execute();
      await trx
        .updateTable('programs')
        .set({ status: 'registration_open', visibility: 'public' })
        .where('org_id', '=', captain.orgId)
        .where('id', '=', fixture.programId)
        .execute();
      await trx
        .updateTable('registration_offerings')
        .set({ active: true, visibility: 'public' })
        .where('org_id', '=', captain.orgId)
        .where('id', '=', fixture.offeringId)
        .execute();
      await trx
        .insertInto('registration_offerings')
        .values({
          id: teamOfferingId,
          org_id: captain.orgId,
          program_id: fixture.programId,
          division_id: fixture.divisionId,
          name: 'Team entry',
          registrant_role: 'team_entry',
          price_cents: 0,
          visibility: 'public',
          active: true,
          capacity: 1,
          requires_approval: true,
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: captain.orgId,
          person_id: captainPersonId,
          account_id: captain.accountId,
          relationship: 'self',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: captain.orgId,
          person_id: playerPersonId,
          account_id: playerAccountId,
          relationship: 'self',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: captain.orgId,
          household_id: playerHouseholdId,
          person_id: playerPersonId,
          role: 'athlete',
        })
        .execute();
      await trx
        .insertInto('capacity_counters')
        .values([
          {
            id: newId(),
            org_id: captain.orgId,
            subject_type: 'program',
            subject_id: fixture.programId,
            capacity: 100,
          },
          {
            id: newId(),
            org_id: captain.orgId,
            subject_type: 'division',
            subject_id: fixture.divisionId,
            capacity: 100,
          },
          {
            id: newId(),
            org_id: captain.orgId,
            subject_type: 'offering',
            subject_id: fixture.offeringId,
            capacity: 100,
          },
          {
            id: newId(),
            org_id: captain.orgId,
            subject_type: 'offering',
            subject_id: teamOfferingId,
            capacity: 1,
          },
        ])
        .execute();
    });

    const service = new PostgresTeamEntries(database, captain);
    const options = await service.options(captain.orgId);
    expect(options).toMatchObject({
      offerings: [
        {
          offeringId: teamOfferingId,
          programName: 'Fixture League',
          divisionName: 'Open',
          offeringName: 'Team entry',
          requiresApproval: true,
        },
      ],
      captains: [{ personId: captainPersonId, name: 'Jordan Captain' }],
    });

    const createRequest = {
      orgId: captain.orgId,
      accountId: captain.accountId,
      idempotencyKey: randomUUID(),
      details: {
        offeringId: teamOfferingId,
        captainPersonId,
        teamName: 'Northside United',
        clubName: 'Northside Soccer',
      },
    };
    const entry = await service.create(createRequest);
    expect(entry).toMatchObject({
      teamName: 'Northside United',
      status: 'pending_approval',
      inviteCount: 0,
    });
    expect(await service.create(createRequest)).toEqual(entry);
    const held = await createWithOrg(database)(captain, (trx) =>
      trx
        .selectFrom('capacity_counters')
        .select(['held', 'confirmed'])
        .where('org_id', '=', captain.orgId)
        .where('subject_type', '=', 'offering')
        .where('subject_id', '=', teamOfferingId)
        .executeTakeFirstOrThrow(),
    );
    expect(held).toEqual({ held: 1, confirmed: 0 });

    const emails = [
      playerEmail,
      ...Array.from(
        { length: 7 },
        (_, index) => `guest-${String(index)}-${randomUUID()}@example.invalid`,
      ),
    ];
    const invited = await service.invitePlayers(captain.orgId, entry.id, {
      emails,
    });
    expect(invited.invites).toHaveLength(8);
    const firstInvite = invited.invites[0];
    if (!firstInvite) throw new Error('Expected a created team invitation');
    expect(firstInvite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await service.listInvites(captain.orgId, entry.id)).toMatchObject({
      invites: emails.map((email) => ({ email, status: 'pending' })),
    });
    const inviteNotice = await createWithOrg(database)(captain, (trx) =>
      trx
        .selectFrom('registration_notice_outbox')
        .select(['account_id', 'kind', 'status'])
        .where('org_id', '=', captain.orgId)
        .where('kind', '=', 'team_entry_invite')
        .where('source_id', '=', firstInvite.id)
        .executeTakeFirstOrThrow(),
    );
    expect(inviteNotice).toEqual({
      account_id: playerAccountId,
      kind: 'team_entry_invite',
      status: 'queued',
    });
    const playerContext = {
      orgId: captain.orgId,
      actor: { accountId: playerAccountId },
    };
    const inviteService = new PostgresTeamEntries(database, playerContext);
    const token = firstInvite.token;
    expect(
      await inviteService.previewInvite(captain.orgId, token),
    ).toMatchObject({
      entryId: entry.id,
      teamName: 'Northside United',
      email: playerEmail,
      status: 'pending',
    });
    await expect(
      service.previewInvite(captain.orgId, token),
    ).rejects.toMatchObject({
      status: 403,
    });
    const [accepted, concurrentReplay] = await Promise.all([
      inviteService.acceptInvite({
        orgId: captain.orgId,
        token,
        details: { personId: playerPersonId, householdId: playerHouseholdId },
      }),
      inviteService.acceptInvite({
        orgId: captain.orgId,
        token,
        details: { personId: playerPersonId, householdId: playerHouseholdId },
      }),
    ]);
    expect(accepted.checkoutId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(concurrentReplay).toEqual(accepted);
    const invitation = await createWithOrg(database)(captain, (trx) =>
      trx
        .selectFrom('team_entry_invites')
        .select(['status', 'person_id', 'checkout_id'])
        .where('org_id', '=', captain.orgId)
        .where('team_entry_id', '=', entry.id)
        .where('email', '=', playerEmail)
        .executeTakeFirstOrThrow(),
    );
    expect(invitation).toEqual({
      status: 'accepted',
      person_id: playerPersonId,
      checkout_id: accepted.checkoutId,
    });

    await expect(
      service.decide(captain.orgId, entry.id, 'declined', 'Withdraw team'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await service.decide(captain.orgId, entry.id, 'approved')).toEqual({
      status: 'accepted',
    });
    const approvedCounter = await createWithOrg(database)(captain, (trx) =>
      trx
        .selectFrom('capacity_counters')
        .select(['held', 'confirmed'])
        .where('org_id', '=', captain.orgId)
        .where('subject_type', '=', 'offering')
        .where('subject_id', '=', teamOfferingId)
        .executeTakeFirstOrThrow(),
    );
    expect(approvedCounter).toEqual({ held: 0, confirmed: 1 });
    const statusNotice = await createWithOrg(database)(captain, (trx) =>
      trx
        .selectFrom('registration_notice_outbox')
        .select(['account_id', 'kind', 'status', 'payload'])
        .where('org_id', '=', captain.orgId)
        .where('kind', '=', 'team_entry_status')
        .where('source_id', '=', entry.id)
        .executeTakeFirstOrThrow(),
    );
    expect(statusNotice).toMatchObject({
      account_id: captain.accountId,
      kind: 'team_entry_status',
      status: 'queued',
      payload: { status: 'accepted', teamName: 'Northside United' },
    });
    const playerStatusNotice = await createWithOrg(database)(captain, (trx) =>
      trx
        .selectFrom('registration_notice_outbox')
        .select(['account_id', 'kind', 'status'])
        .where('org_id', '=', captain.orgId)
        .where('kind', '=', 'team_entry_status')
        .where('source_id', '=', firstInvite.id)
        .executeTakeFirstOrThrow(),
    );
    expect(playerStatusNotice).toEqual({
      account_id: playerAccountId,
      kind: 'team_entry_status',
      status: 'queued',
    });
  });
});
