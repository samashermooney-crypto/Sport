import { randomBytes, randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/db/kysely.js';
import { createWithOrg } from '../../src/db/withOrg.js';
import type { EncryptionKeys } from '../../src/lib/crypto.js';
import { PostgresRegistrationRequirements } from '../../src/modules/registration/requirements.js';
import { PostgresTeamEntries } from '../../src/modules/registration/team-entries.js';
import { createTestFactories } from '../factories.js';

let database: ReturnType<typeof createDatabase>;
const encryption: EncryptionKeys = {
  activeKid: 'team-entry-test',
  keys: new Map([['team-entry-test', randomBytes(32)]]),
};

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
}, 30_000);

describe('team entry registration', () => {
  it('registers an adult captain, records eight player waiver submissions, and approves the team', async () => {
    const factories = createTestFactories(database);
    const captain = await factories.actor();
    const fixture = await factories.program(captain);
    const captainPersonId = await factories.person(captain, {
      firstName: 'Jordan',
      lastName: 'Captain',
      dateOfBirth: '1980-01-01',
    });
    const players: Array<{
      playerAccountId: string;
      personId: string;
      householdId: string;
      email: string;
      firstName: string;
      lastName: string;
    }> = [];
    for (let index = 0; index < 8; index += 1) {
      const playerAccountId = newId();
      const firstName = `Player${String(index + 1)}`;
      const lastName = 'Team';
      const email = `team-player-${randomUUID()}@example.invalid`;
      const personId = await factories.person(captain, {
        firstName,
        lastName,
        dateOfBirth: '1990-02-02',
      });
      const householdId = await factories.household(captain);
      await database
        .insertInto('accounts')
        .values({
          id: playerAccountId,
          email,
          first_name: firstName,
          last_name: lastName,
          date_of_birth: '1990-02-02',
          email_verified_at: new Date(),
        })
        .execute();
      players.push({
        playerAccountId,
        personId,
        householdId,
        email,
        firstName,
        lastName,
      });
    }
    const teamOfferingId = newId();
    const waiverDocumentId = newId();

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
        .set({
          active: true,
          visibility: 'public',
          waiver_document_ids: [waiverDocumentId],
        })
        .where('org_id', '=', captain.orgId)
        .where('id', '=', fixture.offeringId)
        .execute();
      await trx
        .insertInto('waiver_documents')
        .values({
          id: waiverDocumentId,
          org_id: captain.orgId,
          name: 'Adult player waiver',
          body_html: '<p>Each player accepts the team registration terms.</p>',
          requires: 'participant',
          renewal: 'every_registration',
          published_at: new Date(),
        })
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
        .insertInto('household_members')
        .values(
          players.map((player) => ({
            id: newId(),
            org_id: captain.orgId,
            household_id: player.householdId,
            person_id: player.personId,
            role: 'athlete' as const,
          })),
        )
        .execute();
      await trx
        .insertInto('person_account_links')
        .values(
          players.map((player) => ({
            id: newId(),
            org_id: captain.orgId,
            person_id: player.personId,
            account_id: player.playerAccountId,
            relationship: 'self' as const,
            verified_at: new Date(),
          })),
        )
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

    const emails = players.map((player) => player.email);
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
      account_id: players[0]?.playerAccountId,
      kind: 'team_entry_invite',
      status: 'queued',
    });
    const acceptedCheckouts: string[] = [];
    for (const [index, invite] of invited.invites.entries()) {
      const player = players[index];
      if (!player) throw new Error('Expected a team invitee fixture');
      const playerContext = {
        orgId: captain.orgId,
        actor: { accountId: player.playerAccountId },
      };
      const inviteService = new PostgresTeamEntries(database, playerContext);
      if (index === 0) {
        expect(
          await inviteService.previewInvite(captain.orgId, invite.token),
        ).toMatchObject({
          entryId: entry.id,
          teamName: 'Northside United',
          email: player.email,
          status: 'pending',
        });
        await expect(
          service.previewInvite(captain.orgId, invite.token),
        ).rejects.toMatchObject({ status: 403 });
      }
      const accepted =
        index === 0
          ? await Promise.all([
              inviteService.acceptInvite({
                orgId: captain.orgId,
                token: invite.token,
                details: {
                  personId: player.personId,
                  householdId: player.householdId,
                },
              }),
              inviteService.acceptInvite({
                orgId: captain.orgId,
                token: invite.token,
                details: {
                  personId: player.personId,
                  householdId: player.householdId,
                },
              }),
            ]).then(([first, replay]) => {
              expect(replay).toEqual(first);
              return first;
            })
          : await inviteService.acceptInvite({
              orgId: captain.orgId,
              token: invite.token,
              details: {
                personId: player.personId,
                householdId: player.householdId,
              },
            });
      expect(accepted.checkoutId).toMatch(/^[0-9a-f-]{36}$/i);
      acceptedCheckouts.push(accepted.checkoutId);
      const requirements = new PostgresRegistrationRequirements(
        database,
        playerContext,
        encryption,
      );
      const discovery = await requirements.discover({
        orgId: captain.orgId,
        checkoutId: accepted.checkoutId,
      });
      const line = discovery.lines[0];
      const waiver = line?.waivers[0];
      if (!line || !waiver) throw new Error('Team player waiver is missing');
      await requirements.submit({
        orgId: captain.orgId,
        checkoutId: accepted.checkoutId,
        requirements: {
          version: 1,
          lines: [{ lineId: line.lineId, addOns: [], volunteer: 'none' }],
          forms: [],
          waivers: [
            {
              lineId: line.lineId,
              waiverDocumentId: waiver.waiverDocumentId,
              documentVersion: waiver.version,
              documentHash: waiver.documentHash,
              accepted: true,
              signerName: `${player.firstName} ${player.lastName}`,
              method: 'online_typed',
            },
          ],
          discountCodes: [],
          applyCreditCents: 0,
          planTemplateId: null,
          chargeOnApprovalMethodId: null,
        },
        userAgent: 'Track E team-entry acceptance test',
        ip: '127.0.0.1',
      });
    }
    expect(acceptedCheckouts).toHaveLength(8);
    const acceptedInviteRows = await createWithOrg(database)(captain, (trx) =>
      trx
        .selectFrom('team_entry_invites')
        .select(['email', 'status', 'checkout_id'])
        .where('org_id', '=', captain.orgId)
        .where('team_entry_id', '=', entry.id)
        .orderBy('email')
        .execute(),
    );
    expect(acceptedInviteRows).toHaveLength(8);
    expect(
      acceptedInviteRows.every(
        (invite) => invite.status === 'accepted' && invite.checkout_id,
      ),
    ).toBe(true);
    const completedRequirements = await createWithOrg(database)(
      captain,
      (trx) =>
        trx
          .selectFrom('checkouts')
          .select(['requirements', 'requirements_completed_at'])
          .where('org_id', '=', captain.orgId)
          .where('id', 'in', acceptedCheckouts)
          .execute(),
    );
    expect(completedRequirements).toHaveLength(8);
    expect(
      completedRequirements.every((checkout) => {
        if (
          !checkout.requirements ||
          typeof checkout.requirements !== 'object' ||
          Array.isArray(checkout.requirements) ||
          !checkout.requirements_completed_at
        )
          return false;
        const waivers = checkout.requirements['waivers'];
        const waiver = Array.isArray(waivers) ? waivers[0] : null;
        return (
          Array.isArray(waivers) &&
          waivers.length === 1 &&
          waiver !== null &&
          typeof waiver === 'object' &&
          !Array.isArray(waiver) &&
          waiver['accepted'] === true
        );
      }),
    ).toBe(true);

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
      account_id: players[0]?.playerAccountId,
      kind: 'team_entry_status',
      status: 'queued',
    });
  }, 30_000);
});
