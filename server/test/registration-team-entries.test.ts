import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely.js';
import { createWithOrg } from '../src/db/withOrg.js';
import { PostgresTeamEntries } from '../src/modules/registration/team-entries.js';

import { createTestFactories } from './factories.js';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

async function fixture(options: { requiresApproval?: boolean } = {}) {
  const factories = createTestFactories(database);
  const actor = await factories.actor();
  const program = await factories.program(actor);
  const captainPersonId = await factories.person(actor, {
    firstName: 'Jordan',
    lastName: 'Captain',
    dateOfBirth: '1980-03-10',
  });
  const teamOfferingId = newId();
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .where('account_id', '=', actor.accountId)
      .execute();
    await trx
      .insertInto('person_account_links')
      .values({
        id: newId(),
        org_id: actor.orgId,
        person_id: captainPersonId,
        account_id: actor.accountId,
        relationship: 'self',
        verified_at: new Date(),
      })
      .execute();
    await trx
      .updateTable('programs')
      .set({
        status: 'registration_open',
        visibility: 'public',
        eligibility: { minAge: 8, maxAge: 18 },
      })
      .where('org_id', '=', actor.orgId)
      .where('id', '=', program.programId)
      .execute();
    await trx
      .updateTable('registration_offerings')
      .set({ active: true, visibility: 'public', capacity: 20 })
      .where('org_id', '=', actor.orgId)
      .where('id', '=', program.offeringId)
      .execute();
    await trx
      .insertInto('registration_offerings')
      .values({
        id: teamOfferingId,
        org_id: actor.orgId,
        program_id: program.programId,
        division_id: program.divisionId,
        name: 'External team entry',
        registrant_role: 'team_entry',
        price_cents: 0,
        visibility: 'public',
        active: true,
        capacity: 20,
        requires_approval: options.requiresApproval ?? false,
      })
      .execute();
    await trx
      .insertInto('capacity_counters')
      .values([
        {
          id: newId(),
          org_id: actor.orgId,
          subject_type: 'program',
          subject_id: program.programId,
          capacity: 20,
        },
        {
          id: newId(),
          org_id: actor.orgId,
          subject_type: 'division',
          subject_id: program.divisionId,
          capacity: 20,
        },
        {
          id: newId(),
          org_id: actor.orgId,
          subject_type: 'offering',
          subject_id: program.offeringId,
          capacity: 20,
        },
        {
          id: newId(),
          org_id: actor.orgId,
          subject_type: 'offering',
          subject_id: teamOfferingId,
          capacity: 20,
        },
      ])
      .onConflict((oc) =>
        oc
          .columns(['org_id', 'subject_type', 'subject_id'])
          .doUpdateSet((eb) => ({
            capacity: eb.ref('excluded.capacity'),
            confirmed: eb.ref('excluded.confirmed'),
            held: eb.ref('excluded.held'),
          })),
      )
      .execute();
  });
  return {
    actor,
    program,
    captainPersonId,
    teamOfferingId,
    entries: new PostgresTeamEntries(database, actor),
    factories,
  };
}

function createDetails(
  offeringId: string,
  captainPersonId: string,
  teamName = 'Northside United',
) {
  return { offeringId, captainPersonId, teamName };
}

describe('team entry registration', () => {
  it('lists an open offering and reserves team capacity exactly once for a replayed request', async () => {
    const { actor, program, captainPersonId, teamOfferingId, entries } =
      await fixture();
    const options = await entries.options(actor.orgId);
    expect(options).toMatchObject({
      offerings: [
        {
          offeringId: teamOfferingId,
          programName: 'Fixture League',
          divisionName: 'Open',
          offeringName: 'External team entry',
          requiresApproval: false,
        },
      ],
      captains: [{ personId: captainPersonId, name: 'Jordan Captain' }],
    });

    const key = newId();
    const details = createDetails(teamOfferingId, captainPersonId);
    const created = await entries.create({
      orgId: actor.orgId,
      accountId: actor.accountId,
      idempotencyKey: key,
      details,
    });
    expect(created).toMatchObject({
      teamName: 'Northside United',
      status: 'accepted',
      captainPersonId,
      seedHint: null,
      inviteCount: 0,
    });
    expect(
      await entries.create({
        orgId: actor.orgId,
        accountId: actor.accountId,
        idempotencyKey: key,
        details,
      }),
    ).toEqual(created);
    await expect(
      entries.create({
        orgId: actor.orgId,
        accountId: actor.accountId,
        idempotencyKey: key,
        details: createDetails(teamOfferingId, captainPersonId, 'Changed Name'),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });

    const counters = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('capacity_counters')
        .select(['subject_type', 'subject_id', 'confirmed', 'held'])
        .where('org_id', '=', actor.orgId)
        .where('subject_id', 'in', [
          program.programId,
          program.divisionId,
          teamOfferingId,
        ])
        .orderBy('subject_type')
        .execute(),
    );
    expect(counters).toHaveLength(3);
    expect(counters.every((row) => row.confirmed === 1 && row.held === 0)).toBe(
      true,
    );
    expect(await entries.listMine(actor.orgId)).toMatchObject({
      entries: [{ id: created.id, teamName: 'Northside United' }],
    });
    expect(await entries.listStaff(actor.orgId)).toMatchObject({
      entries: [{ id: created.id }],
    });
  });

  it('fails closed for a closed, priced, full-capacity, or unverified captain request', async () => {
    const { actor, program, captainPersonId, teamOfferingId, entries } =
      await fixture();
    const details = createDetails(teamOfferingId, captainPersonId);
    const call = (idempotencyKey = newId()) =>
      entries.create({
        orgId: actor.orgId,
        accountId: actor.accountId,
        idempotencyKey,
        details,
      });

    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('registration_offerings')
        .set({ price_cents: 2500 })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', teamOfferingId)
        .execute(),
    );
    await expect(call()).rejects.toMatchObject({
      code: 'INELIGIBLE',
      status: 409,
    });
    const optionsWithPrice = await entries.options(actor.orgId);
    expect(optionsWithPrice.offerings).toHaveLength(0);

    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('registration_offerings')
        .set({ price_cents: 0, active: false })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', teamOfferingId)
        .execute();
      await trx
        .updateTable('programs')
        .set({ status: 'registration_closed' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
    });
    await expect(call()).rejects.toMatchObject({
      code: 'INELIGIBLE',
      status: 409,
    });

    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ status: 'registration_open' })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .updateTable('registration_offerings')
        .set({ active: true })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', teamOfferingId)
        .execute();
      await trx
        .updateTable('capacity_counters')
        .set({ confirmed: 20 })
        .where('org_id', '=', actor.orgId)
        .where('subject_type', '=', 'offering')
        .where('subject_id', '=', teamOfferingId)
        .execute();
    });
    await expect(call()).rejects.toMatchObject({
      code: 'CAPACITY_FULL',
      status: 409,
    });

    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('capacity_counters')
        .set({ confirmed: 0 })
        .where('org_id', '=', actor.orgId)
        .where('subject_type', '=', 'offering')
        .where('subject_id', '=', teamOfferingId)
        .execute(),
    );
    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('person_account_links')
        .set({ verified_at: null })
        .where('org_id', '=', actor.orgId)
        .where('person_id', '=', captainPersonId)
        .where('account_id', '=', actor.accountId)
        .execute(),
    );
    await expect(call()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('creates a verified-player checkout from an invitation and replays acceptance for the same person', async () => {
    const { actor, captainPersonId, teamOfferingId, entries, factories } =
      await fixture();
    const team = await entries.create({
      orgId: actor.orgId,
      accountId: actor.accountId,
      idempotencyKey: newId(),
      details: createDetails(teamOfferingId, captainPersonId),
    });
    const email = `teammate-${randomUUID()}@example.invalid`;
    const teammateAccountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: teammateAccountId,
        email,
        first_name: 'Avery',
        last_name: 'Teammate',
        date_of_birth: '1990-02-20',
        email_verified_at: new Date(),
      })
      .execute();
    const teammateContext = {
      orgId: actor.orgId,
      actor: { accountId: teammateAccountId },
    };
    const teammatePersonId = await factories.person(actor, {
      firstName: 'Avery',
      lastName: 'Teammate',
      dateOfBirth: '2012-04-01',
    });
    const householdId = await factories.household(actor);
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: actor.orgId,
          household_id: householdId,
          person_id: teammatePersonId,
          role: 'athlete',
          financially_responsible: false,
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: actor.orgId,
          person_id: teammatePersonId,
          account_id: teammateAccountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
    });
    const invitations = await entries.invitePlayers(actor.orgId, team.id, {
      emails: [email],
    });
    const invite = invitations.invites[0];
    if (!invite) throw new Error('Team invite was not returned');
    const teammateEntries = new PostgresTeamEntries(database, teammateContext);
    expect(
      await teammateEntries.previewInvite(actor.orgId, invite.token),
    ).toMatchObject({
      entryId: team.id,
      teamName: 'Northside United',
      status: 'pending',
      email,
    });
    const accepted = await teammateEntries.acceptInvite({
      orgId: actor.orgId,
      token: invite.token,
      details: { personId: teammatePersonId, householdId },
    });
    expect(accepted.checkoutId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(
      await teammateEntries.acceptInvite({
        orgId: actor.orgId,
        token: invite.token,
        details: { personId: teammatePersonId, householdId },
      }),
    ).toEqual(accepted);
    const registrationInvite = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('team_entry_invites')
        .select(['status', 'person_id', 'checkout_id'])
        .where('org_id', '=', actor.orgId)
        .where('id', '=', invite.id)
        .executeTakeFirstOrThrow(),
    );
    expect(registrationInvite).toMatchObject({
      status: 'accepted',
      person_id: teammatePersonId,
      checkout_id: accepted.checkoutId,
    });
  });

  it('holds capacity pending team review, then approves or declines with scoped notices', async () => {
    const { actor, program, captainPersonId, teamOfferingId, entries } =
      await fixture({ requiresApproval: true });
    const first = await entries.create({
      orgId: actor.orgId,
      accountId: actor.accountId,
      idempotencyKey: newId(),
      details: createDetails(teamOfferingId, captainPersonId, 'Review United'),
    });
    expect(first.status).toBe('pending_approval');
    const inviteEmail = `review-player-${randomUUID()}@example.invalid`;
    await entries.invitePlayers(actor.orgId, first.id, {
      emails: [inviteEmail],
    });
    expect(await entries.listInvites(actor.orgId, first.id)).toMatchObject({
      invites: [{ email: inviteEmail, status: 'pending' }],
    });
    const approved = await entries.decide(
      actor.orgId,
      first.id,
      'approved',
      'Roster reviewed',
    );
    expect(approved.status).toBe('accepted');
    await expect(
      entries.decide(actor.orgId, first.id, 'approved'),
    ).rejects.toMatchObject({ code: 'DECISION_ALREADY_RECORDED' });

    const second = await entries.create({
      orgId: actor.orgId,
      accountId: actor.accountId,
      idempotencyKey: newId(),
      details: createDetails(teamOfferingId, captainPersonId, 'Review City'),
    });
    await entries.invitePlayers(actor.orgId, second.id, {
      emails: [`declined-player-${randomUUID()}@example.invalid`],
    });
    const declined = await entries.decide(
      actor.orgId,
      second.id,
      'declined',
      'No roster submission',
    );
    expect(declined.status).toBe('declined');
    expect(await entries.listInvites(actor.orgId, second.id)).toMatchObject({
      invites: [{ status: 'canceled' }],
    });
    const counters = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('capacity_counters')
        .select(['subject_type', 'confirmed', 'held'])
        .where('org_id', '=', actor.orgId)
        .where('subject_id', 'in', [
          program.programId,
          program.divisionId,
          teamOfferingId,
        ])
        .execute(),
    );
    expect(counters).toHaveLength(3);
    expect(counters.every((row) => row.confirmed === 1 && row.held === 0)).toBe(
      true,
    );
    const noticeCount = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('registration_notice_outbox')
        .select('id')
        .where('org_id', '=', actor.orgId)
        .where('kind', '=', 'team_entry_status')
        .execute(),
    );
    expect(noticeCount.length).toBeGreaterThanOrEqual(2);
  });

  it('prevents cross-organization account use and declines after a player checkout starts', async () => {
    const { actor, captainPersonId, teamOfferingId, entries } = await fixture({
      requiresApproval: true,
    });
    await expect(
      entries.create({
        orgId: newId(),
        accountId: actor.accountId,
        idempotencyKey: newId(),
        details: createDetails(teamOfferingId, captainPersonId),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const team = await entries.create({
      orgId: actor.orgId,
      accountId: actor.accountId,
      idempotencyKey: newId(),
      details: createDetails(
        teamOfferingId,
        captainPersonId,
        'Checkout United',
      ),
    });
    const email = `player-${randomUUID()}@example.invalid`;
    const accountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email,
        first_name: 'Taylor',
        last_name: 'Player',
        date_of_birth: '1990-04-03',
        email_verified_at: new Date(),
      })
      .execute();
    const factories = createTestFactories(database);
    const teammatePersonId = await factories.person(actor, {
      firstName: 'Taylor',
      lastName: 'Player',
      dateOfBirth: '2012-05-20',
    });
    const householdId = await factories.household(actor);
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: actor.orgId,
          household_id: householdId,
          person_id: teammatePersonId,
          role: 'athlete',
          financially_responsible: false,
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: actor.orgId,
          person_id: teammatePersonId,
          account_id: accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
    });
    const playerContext = { orgId: actor.orgId, actor: { accountId } };
    const invitation = await entries.invitePlayers(actor.orgId, team.id, {
      emails: [email],
    });
    const token = invitation.invites[0]?.token;
    if (!token) throw new Error('Player invite token is missing');
    const playerEntries = new PostgresTeamEntries(database, playerContext);
    const playerCheckout = await playerEntries.acceptInvite({
      orgId: actor.orgId,
      token,
      details: {
        personId: teammatePersonId,
        householdId,
      },
    });
    expect(playerCheckout.checkoutId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(
      entries.decide(actor.orgId, team.id, 'declined'),
    ).rejects.toMatchObject({
      code: 'TEAM_ENTRY_UNAVAILABLE',
      status: 409,
    });
  });
});
