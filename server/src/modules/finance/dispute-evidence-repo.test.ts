import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresDisputeEvidenceRepository } from './dispute-evidence-repo.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';

let database: Kysely<DB>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

describe('Postgres dispute evidence', () => {
  it('builds a factual packet and fences a single external submission', async () => {
    const accountId = newId();
    const orgId = newId();
    const actor: OrgContext = { orgId, actor: { accountId } };
    const seasonId = newId();
    const sportId = newId();
    const programId = newId();
    const divisionId = newId();
    const offeringId = newId();
    const personId = newId();
    const householdId = newId();
    const registrationId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `dispute-evidence-${randomUUID()}@example.invalid`,
        first_name: 'Evidence',
        last_name: 'Test',
        date_of_birth: '1990-01-01',
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `dispute-evidence-${randomUUID().slice(0, 8)}`,
        name: 'Dispute Evidence Test',
        kind: 'club',
        timezone: 'America/Chicago',
      })
      .execute();
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: 'Season',
          starts_on: '2026-01-01',
          ends_on: '2027-12-31',
        })
        .execute();
      await trx
        .insertInto('sport_profiles')
        .values({ id: sportId, org_id: orgId, name: 'Sport', profile: {} })
        .execute();
      await trx
        .insertInto('programs')
        .values({
          id: programId,
          org_id: orgId,
          season_id: seasonId,
          sport_profile_id: sportId,
          mode: 'league',
          name: 'Fixture League',
          slug: `dispute-${randomUUID().slice(0, 8)}`,
          starts_on: '2026-01-01',
          ends_on: '2027-12-31',
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
          name: 'Base',
          registrant_role: 'athlete',
          price_cents: 1000,
        })
        .execute();
      await trx
        .insertInto('people')
        .values({
          id: personId,
          org_id: orgId,
          first_name: 'Athlete',
          last_name: 'Test',
          date_of_birth: '2014-01-01',
        })
        .execute();
      await trx
        .insertInto('households')
        .values({ id: householdId, org_id: orgId, name: 'Test Household' })
        .execute();
      await trx
        .insertInto('registrations')
        .values({
          id: registrationId,
          org_id: orgId,
          program_id: programId,
          division_id: divisionId,
          offering_id: offeringId,
          person_id: personId,
          household_id: householdId,
          registered_by_account_id: accountId,
          source: 'staff',
          status: 'confirmed',
        })
        .execute();
    });
    const invoice = await new PostgresInvoiceRepository(database, actor).issue({
      orgId,
      accountId,
      source: 'checkout',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'registration',
          description: 'Program',
          amountCents: 1000,
          refundable: true,
        },
      ],
      refundTerms: {
        policy: { rules: [], afterLastBps: 5000, serviceFeeRefund: 'none' },
        approvalThresholdCents: 500,
        refundApplicationFee: true,
      },
    });
    const disputeId = `dp_${randomUUID()}`;
    await createWithOrg(database)(actor, async (trx) => {
      const line = await trx
        .selectFrom('invoice_lines')
        .select('id')
        .where('org_id', '=', orgId)
        .where('invoice_id', '=', invoice.id)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('registrations')
        .set({ invoice_line_id: line.id })
        .where('org_id', '=', orgId)
        .where('id', '=', registrationId)
        .execute();
      const waiverId = newId();
      await trx
        .insertInto('waiver_documents')
        .values({
          id: waiverId,
          org_id: orgId,
          name: 'Registration waiver',
          body_html: '<p>Waiver</p>',
          requires: 'guardian_if_minor',
          renewal: 'every_registration',
          published_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('waiver_signatures')
        .values({
          id: newId(),
          org_id: orgId,
          waiver_document_id: waiverId,
          document_version: 1,
          document_hash: Buffer.alloc(32),
          participant_person_id: personId,
          signer_account_id: accountId,
          signer_name_typed: 'Test Actor',
          method: 'online_typed',
          registration_id: registrationId,
        })
        .execute();
      const paymentId = newId();
      const chargeId = `ch_${randomUUID()}`;
      await trx
        .insertInto('payments')
        .values({
          id: paymentId,
          org_id: orgId,
          account_id: accountId,
          method: 'card',
          status: 'succeeded',
          amount_cents: 1000,
          stripe_payment_intent_id: `pi_${randomUUID()}`,
          stripe_charge_id: chargeId,
          succeeded_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('payment_allocations')
        .values({
          id: newId(),
          org_id: orgId,
          payment_id: paymentId,
          invoice_id: invoice.id,
          amount_cents: 1000,
        })
        .execute();
      await trx
        .updateTable('invoices')
        .set({ paid_cents: 1000, status: 'paid' })
        .where('org_id', '=', orgId)
        .where('id', '=', invoice.id)
        .execute();
      await trx
        .insertInto('disputes')
        .values({
          id: newId(),
          org_id: orgId,
          payment_id: paymentId,
          invoice_id: invoice.id,
          stripe_dispute_id: disputeId,
          stripe_charge_id: chargeId,
          status: 'needs_response',
          amount_cents: 500,
          evidence_due_by: new Date(Date.now() + 86_400_000),
        })
        .execute();
    });
    const repository = new PostgresDisputeEvidenceRepository(database, actor);
    const claim = await repository.claim(orgId, disputeId);
    expect(claim.kind).toBe('reserved');
    if (claim.kind !== 'reserved')
      throw new Error('Expected reserved evidence');
    expect(claim.evidence.uncategorized_text).toContain(registrationId);
    expect(claim.evidence.uncategorized_text).toContain('waiver signed');
    expect(claim.evidence.uncategorized_text).toContain('Refund terms frozen');
    expect(await repository.claim(orgId, disputeId)).toEqual(claim);
    await repository.beginExternal(orgId, disputeId, claim.key);
    expect(await repository.claim(orgId, disputeId)).toEqual({ kind: 'busy' });
    await repository.complete(orgId, disputeId, claim.key, 'under_review');
    expect(await repository.claim(orgId, disputeId)).toEqual({
      kind: 'replay',
      status: 'under_review',
    });
  });
});
