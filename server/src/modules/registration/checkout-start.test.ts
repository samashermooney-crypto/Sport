import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { newId } from '@shared/ids';
import express from 'express';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg } from '../../db/withOrg.js';
import { decryptRestricted, type EncryptionKeys } from '../../lib/crypto.js';
import type { AuthDependencies } from '../auth/routes.js';

import { PostgresRegistrationCheckoutQuote } from './checkout-quote.js';
import { PostgresRegistrationCheckoutStart } from './checkout-start.js';
import { PostgresRegistrationLifecycle } from './lifecycle.js';
import { PostgresCheckoutPolicyAcceptance } from './policy-acceptance.js';
import { waiverDocumentHash } from './requirements.js';
import { createRegistrationRouter } from './routes.js';

let database: Kysely<DB>;
const accountId = newId();
const otherAccountId = newId();
const orgId = newId();
const personId = newId();
const householdId = newId();
const programId = newId();
const divisionId = newId();
const offeringId = newId();
const context = { orgId, actor: { accountId } };
const encryption: EncryptionKeys = {
  activeKid: 'registration-test',
  keys: new Map([['registration-test', randomBytes(32)]]),
};
const cart = {
  offerings: [
    {
      lineId: newId(),
      offeringId,
      personId,
      householdId,
    },
  ],
};
let token: string;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let startedCheckoutId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  await database
    .insertInto('accounts')
    .values([
      {
        id: accountId,
        email: `register-${randomUUID()}@example.invalid`,
        first_name: 'Family',
        last_name: 'One',
        date_of_birth: '1990-01-01',
      },
      {
        id: otherAccountId,
        email: `register-${randomUUID()}@example.invalid`,
        first_name: 'Other',
        last_name: 'Family',
        date_of_birth: '1990-01-01',
      },
    ])
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `register-${randomUUID().slice(0, 12)}`,
      name: 'Registration Checkout Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  await createWithOrg(database)(context, async (trx) => {
    const profileId = newId();
    const seasonId = newId();
    await trx
      .insertInto('sport_profiles')
      .values({
        id: profileId,
        org_id: orgId,
        name: 'Soccer',
        profile: {
          ageGroup: {
            method: 'age_on_date',
            monthDay: '09-01',
            yearBasis: 'season_start',
          },
        },
      })
      .execute();
    await trx
      .insertInto('seasons')
      .values({
        id: seasonId,
        org_id: orgId,
        name: '2026 fall',
        starts_on: '2026-09-01',
        ends_on: '2026-12-01',
        status: 'active',
      })
      .execute();
    await trx
      .insertInto('programs')
      .values({
        id: programId,
        org_id: orgId,
        season_id: seasonId,
        sport_profile_id: profileId,
        mode: 'league',
        name: 'Fall Soccer',
        slug: 'fall-soccer',
        status: 'registration_open',
        visibility: 'public',
        starts_on: '2026-09-01',
        ends_on: '2026-12-01',
        eligibility: { minAge: 8, maxAge: 16 },
      })
      .execute();
    await trx
      .insertInto('divisions')
      .values({
        id: divisionId,
        org_id: orgId,
        program_id: programId,
        name: 'Youth',
      })
      .execute();
    await trx
      .insertInto('registration_offerings')
      .values({
        id: offeringId,
        org_id: orgId,
        program_id: programId,
        division_id: divisionId,
        name: 'Youth player',
        registrant_role: 'athlete',
        price_cents: 2500,
        visibility: 'public',
        active: true,
        capacity: 1,
      })
      .execute();
    await trx
      .insertInto('people')
      .values({
        id: personId,
        org_id: orgId,
        first_name: 'Maya',
        last_name: 'One',
        date_of_birth: '2012-05-01',
      })
      .execute();
    await trx
      .insertInto('households')
      .values({
        id: householdId,
        org_id: orgId,
        name: 'One household',
      })
      .execute();
    await trx
      .insertInto('household_members')
      .values({
        id: newId(),
        org_id: orgId,
        household_id: householdId,
        person_id: personId,
        role: 'athlete',
      })
      .execute();
    await trx
      .insertInto('person_account_links')
      .values({
        id: newId(),
        org_id: orgId,
        person_id: personId,
        account_id: accountId,
        relationship: 'guardian',
        verified_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('capacity_counters')
      .values([
        {
          id: newId(),
          org_id: orgId,
          subject_type: 'program',
          subject_id: programId,
          capacity: 1,
        },
        {
          id: newId(),
          org_id: orgId,
          subject_type: 'division',
          subject_id: divisionId,
          capacity: 1,
        },
        {
          id: newId(),
          org_id: orgId,
          subject_type: 'offering',
          subject_id: offeringId,
          capacity: 1,
        },
      ])
      .execute();
  });
  token = randomBytes(32).toString('base64url');
  await database
    .insertInto('sessions')
    .values({
      id: newId(),
      account_id: accountId,
      token_hash: createHash('sha256').update(token).digest(),
      kind: 'cookie',
      client: 'web',
      privileged: false,
      idle_expires_at: new Date(Date.now() + 60 * 60_000),
      absolute_expires_at: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .execute();
  const app = express();
  app.use(
    '/api/v1/registration',
    createRegistrationRouter({
      database,
      appUrl: 'http://127.0.0.1:5173',
      clock: () => new Date(),
      encryption,
    } as AuthDependencies),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/registration`;
});

afterAll(async () => {
  server.close();
  await database.destroy();
});

describe('registration checkout start', () => {
  it('lists only public offerings for an authenticated family', async () => {
    const path = `${baseUrl}/orgs/${orgId}/catalog`;
    expect((await fetch(path)).status).toBe(401);
    const response = await fetch(path, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { offeringId: string; status: string }[];
    };
    expect(body.items).toMatchObject([{ offeringId, status: 'open' }]);
    const family = await fetch(`${baseUrl}/orgs/${orgId}/participants`, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
    });
    expect(family.status).toBe(200);
    expect(await family.json()).toMatchObject({
      people: [{ personId, householdId }],
    });
  });

  it('reserves one seat for an eligible child and replays an exact cart key', async () => {
    const repo = new PostgresRegistrationCheckoutStart(database, context);
    const creationKey = randomUUID();
    const first = await repo.start({ orgId, creationKey, cart });
    startedCheckoutId = first.checkoutId;
    expect(first.status).toBe('open');
    expect(await repo.start({ orgId, creationKey, cart })).toEqual(first);
    const line = cart.offerings[0];
    if (!line) throw new Error('Cart fixture has no line');
    await expect(
      repo.start({
        orgId,
        creationKey,
        cart: {
          offerings: [{ ...line, lineId: newId() }],
        },
      }),
    ).rejects.toMatchObject({ code: 'KEY_CONFLICT' });
    const counters = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('capacity_counters')
        .select(['held', 'confirmed'])
        .where('org_id', '=', orgId)
        .execute(),
    );
    expect(counters).toHaveLength(3);
    expect(counters.every((row) => row.held === 1 && row.confirmed === 0)).toBe(
      true,
    );
  });

  it('refuses capacity overflow, unrelated accounts and age-ineligible carts', async () => {
    const repo = new PostgresRegistrationCheckoutStart(database, context);
    await expect(
      repo.start({ orgId, creationKey: randomUUID(), cart }),
    ).rejects.toMatchObject({ code: 'CAPACITY_FULL' });
    await expect(
      new PostgresRegistrationCheckoutStart(database, {
        orgId,
        actor: { accountId: otherAccountId },
      }).start({ orgId, creationKey: randomUUID(), cart }),
    ).rejects.toMatchObject({ code: 'PARTICIPANT_ACCESS' });
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('programs')
        .set({ eligibility: { maxAge: 10 } })
        .where('org_id', '=', orgId)
        .where('id', '=', programId)
        .execute(),
    );
    await expect(
      repo.start({ orgId, creationKey: randomUUID(), cart }),
    ).rejects.toMatchObject({ code: 'INELIGIBLE' });
  });

  it('resumes only its payer-owned cart and reports eligibility errors through HTTP', async () => {
    const path = `${baseUrl}/orgs/${orgId}/checkouts/${startedCheckoutId}`;
    expect((await fetch(path)).status).toBe(401);
    const response = await fetch(path, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      checkoutId: startedCheckoutId,
      cart,
    });
    const full = await fetch(`${baseUrl}/orgs/${orgId}/checkouts`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-athlentry_session=${token}`,
        Origin: 'http://127.0.0.1:5173',
        'X-Athlentry-Request': '1',
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cart),
    });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: { code: 'INELIGIBLE' } });
  });

  it('freezes one paid quote with a reconciled invoice and pending registration', async () => {
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ eligibility: {} })
        .where('org_id', '=', orgId)
        .where('id', '=', programId)
        .execute();
      await trx
        .updateTable('organizations')
        .set({
          settings: {
            refundTerms: {
              policy: {
                rules: [],
                afterLastBps: 10_000,
                serviceFeeRefund: 'proportional',
              },
              approvalThresholdCents: 10_000,
              refundApplicationFee: true,
            },
          },
        })
        .where('id', '=', orgId)
        .execute();
    });
    const quote = new PostgresRegistrationCheckoutQuote(database, context);
    const input = {
      orgId,
      checkoutId: startedCheckoutId,
      quoteKey: randomUUID(),
    };
    const policy = new PostgresCheckoutPolicyAcceptance(database, context);
    const review = await policy.review(startedCheckoutId);
    expect(review.accepted).toBe(false);
    await expect(quote.quote(input)).rejects.toMatchObject({
      code: 'REFUND_TERMS_UNACCEPTED',
    });
    await expect(
      policy.accept(startedCheckoutId, 'a'.repeat(64), 'Vitest'),
    ).rejects.toMatchObject({ code: 'REFUND_POLICY_CHANGED' });
    expect(
      await policy.accept(startedCheckoutId, review.termsHash, 'Vitest'),
    ).toMatchObject({ accepted: true, termsHash: review.termsHash });
    expect((await policy.review(startedCheckoutId)).accepted).toBe(true);
    const first = await quote.quote(input);
    expect(first).toMatchObject({ totalCents: 2500, chargeNowCents: 2500 });
    expect(await quote.quote(input)).toEqual(first);
    const replay = await fetch(
      `${baseUrl}/orgs/${orgId}/checkouts/${startedCheckoutId}/quote`,
      {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: 'http://127.0.0.1:5173',
          'X-Athlentry-Request': '1',
          'Idempotency-Key': input.quoteKey,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    const state = await createWithOrg(database)(context, async (trx) => ({
      invoice: await trx
        .selectFrom('invoices')
        .select(['total_cents', 'balance_cents', 'source'])
        .where('org_id', '=', orgId)
        .where('id', '=', first.invoiceId)
        .executeTakeFirstOrThrow(),
      registrations: await trx
        .selectFrom('registrations')
        .select(['status', 'checkout_id', 'invoice_line_id'])
        .where('org_id', '=', orgId)
        .where('checkout_id', '=', startedCheckoutId)
        .execute(),
      checkout: await trx
        .selectFrom('checkouts')
        .select('status')
        .where('org_id', '=', orgId)
        .where('id', '=', startedCheckoutId)
        .executeTakeFirstOrThrow(),
    }));
    expect(state.invoice).toEqual({
      total_cents: 2500,
      balance_cents: 2500,
      source: 'checkout',
    });
    expect(state.registrations).toHaveLength(1);
    expect(state.registrations[0]).toMatchObject({
      status: 'pending_payment',
      checkout_id: startedCheckoutId,
    });
    expect(state.registrations[0]?.invoice_line_id).toBeTruthy();
    expect(state.checkout.status).toBe('awaiting_payment');
  });

  it('encrypts restricted registration answers at rest through requirements submission and quote', async () => {
    const formId = newId();
    const guardianWaiverId = newId();
    const bothWaiverId = newId();
    const secondProgramId = newId();
    const secondDivisionId = newId();
    const secondOfferingId = newId();
    const secondLineId = newId();
    await createWithOrg(database)(context, async (trx) => {
      const source = await trx
        .selectFrom('programs')
        .select(['season_id', 'sport_profile_id'])
        .where('org_id', '=', orgId)
        .where('id', '=', programId)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('programs')
        .values({
          id: secondProgramId,
          org_id: orgId,
          season_id: source.season_id,
          sport_profile_id: source.sport_profile_id,
          mode: 'league',
          name: 'Form registration',
          slug: `form-${randomUUID().slice(0, 8)}`,
          status: 'registration_open',
          visibility: 'public',
          starts_on: '2026-09-01',
          ends_on: '2026-12-01',
          settings: {},
        })
        .execute();
      await trx
        .insertInto('divisions')
        .values({
          id: secondDivisionId,
          org_id: orgId,
          program_id: secondProgramId,
          name: 'Form group',
        })
        .execute();
      await trx
        .insertInto('form_definitions')
        .values({
          id: formId,
          org_id: orgId,
          scope: 'registration',
          owner_type: 'org',
          name: 'Player details',
          schema: {
            fields: [
              {
                key: 'allergy',
                label: 'Allergy information',
                required: true,
                sensitivity: 'restricted',
              },
              {
                key: 'jersey',
                label: 'Jersey number',
                required: true,
                sensitivity: 'internal',
              },
            ],
          },
          published_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('waiver_documents')
        .values([
          {
            id: guardianWaiverId,
            org_id: orgId,
            name: 'Guardian waiver',
            body_html: '<p>Guardian accepts these terms.</p>',
            requires: 'guardian_if_minor',
            renewal: 'every_registration',
            published_at: new Date(),
          },
          {
            id: bothWaiverId,
            org_id: orgId,
            name: 'Guardian and player waiver',
            body_html: '<p>Both guardian and player accept.</p>',
            requires: 'both',
            renewal: 'annual_season',
            published_at: new Date(),
          },
        ])
        .execute();
      await trx
        .insertInto('registration_offerings')
        .values({
          id: secondOfferingId,
          org_id: orgId,
          program_id: secondProgramId,
          division_id: secondDivisionId,
          name: 'Youth player with form',
          registrant_role: 'athlete',
          price_cents: 2500,
          visibility: 'public',
          active: true,
          capacity: 1,
          form_definition_ids: [formId],
          waiver_document_ids: [guardianWaiverId, bothWaiverId],
        })
        .execute();
      await trx
        .insertInto('capacity_counters')
        .values({
          id: newId(),
          org_id: orgId,
          subject_type: 'offering',
          subject_id: secondOfferingId,
          capacity: 1,
        })
        .execute();
      await trx
        .insertInto('capacity_counters')
        .values([
          {
            id: newId(),
            org_id: orgId,
            subject_type: 'program',
            subject_id: secondProgramId,
            capacity: 1,
          },
          {
            id: newId(),
            org_id: orgId,
            subject_type: 'division',
            subject_id: secondDivisionId,
            capacity: 1,
          },
        ])
        .execute();
    });
    const secondCart = {
      offerings: [
        {
          lineId: secondLineId,
          offeringId: secondOfferingId,
          personId,
          householdId,
        },
      ],
    };
    const started = await new PostgresRegistrationCheckoutStart(
      database,
      context,
    ).start({
      orgId,
      creationKey: randomUUID(),
      cart: secondCart,
    });
    const discovered = await fetch(
      `${baseUrl}/orgs/${orgId}/checkouts/${started.checkoutId}/requirements`,
      { headers: { Cookie: `__Host-athlentry_session=${token}` } },
    );
    expect(discovered.status).toBe(200);
    const payload = {
      version: 1,
      lines: [{ lineId: secondLineId, addOns: [], volunteer: 'none' }],
      forms: [
        {
          lineId: secondLineId,
          formDefinitionId: formId,
          definitionVersion: 1,
          answers: { allergy: 'peanut allergy details', jersey: '12' },
        },
      ],
      waivers: [
        {
          lineId: secondLineId,
          waiverDocumentId: guardianWaiverId,
          documentVersion: 1,
          documentHash: waiverDocumentHash(
            '<p>Guardian accepts these terms.</p>',
          ),
          accepted: true,
          signerName: 'Family One',
          method: 'online_typed',
        },
        {
          lineId: secondLineId,
          waiverDocumentId: bothWaiverId,
          documentVersion: 1,
          documentHash: waiverDocumentHash(
            '<p>Both guardian and player accept.</p>',
          ),
          accepted: true,
          signerName: 'Family One',
          participantSignerName: 'Maya One',
          method: 'online_typed',
        },
      ],
      discountCodes: [],
      applyCreditCents: 0,
      planTemplateId: null,
      chargeOnApprovalMethodId: null,
    };
    const submitted = await fetch(
      `${baseUrl}/orgs/${orgId}/checkouts/${started.checkoutId}/requirements`,
      {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: 'http://127.0.0.1:5173',
          'X-Athlentry-Request': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    expect(submitted.status).toBe(200);
    const storedCheckout = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('checkouts')
        .select(['requirements', 'requirements_enc'])
        .where('org_id', '=', orgId)
        .where('id', '=', started.checkoutId)
        .executeTakeFirstOrThrow(),
    );
    expect(JSON.stringify(storedCheckout.requirements)).not.toContain(
      'peanut allergy details',
    );
    const encryptedCheckoutRequirements = storedCheckout.requirements_enc;
    if (!encryptedCheckoutRequirements)
      throw new Error('Restricted checkout answers were not encrypted');
    expect(
      decryptRestricted(encryptedCheckoutRequirements, encryption).toString(
        'utf8',
      ),
    ).toContain('peanut allergy details');

    const policy = new PostgresCheckoutPolicyAcceptance(database, context);
    const review = await policy.review(started.checkoutId);
    await policy.accept(started.checkoutId, review.termsHash, 'Vitest');
    const quote = await new PostgresRegistrationCheckoutQuote(
      database,
      context,
      encryption,
    ).quote({
      orgId,
      checkoutId: started.checkoutId,
      quoteKey: randomUUID(),
    });
    expect(quote.totalCents).toBe(2500);
    const responses = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('form_responses')
        .select(['answers', 'answers_enc'])
        .where('org_id', '=', orgId)
        .where('form_definition_id', '=', formId)
        .execute(),
    );
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(JSON.stringify(response.answers)).not.toContain(
        'peanut allergy details',
      );
      expect(response.answers).toEqual({ jersey: '12' });
      if (!response.answers_enc)
        throw new Error('Restricted form answers were not encrypted');
      expect(
        decryptRestricted(response.answers_enc, encryption).toString('utf8'),
      ).toBe(JSON.stringify({ allergy: 'peanut allergy details' }));
    }
    const signatures = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('waiver_signatures')
        .select(['waiver_document_id', 'signer_person_id', 'signer_name_typed'])
        .where('org_id', '=', orgId)
        .where('participant_person_id', '=', personId)
        .execute(),
    );
    expect(signatures).toHaveLength(3);
    expect(signatures).toContainEqual({
      waiver_document_id: guardianWaiverId,
      signer_person_id: null,
      signer_name_typed: 'Family One',
    });
    expect(signatures).toContainEqual({
      waiver_document_id: bothWaiverId,
      signer_person_id: null,
      signer_name_typed: 'Family One',
    });
    expect(signatures).toContainEqual({
      waiver_document_id: bothWaiverId,
      signer_person_id: personId,
      signer_name_typed: 'Maya One',
    });

    const lifecycle = new PostgresRegistrationLifecycle(database, context);
    const registration = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('registrations')
        .select('id')
        .where('org_id', '=', orgId)
        .where('checkout_id', '=', started.checkoutId)
        .executeTakeFirstOrThrow(),
    );
    const cancellation = {
      orgId,
      registrationId: registration.id,
      reason: 'Family schedule changed',
      staff: false,
      idempotencyKey: randomUUID(),
    };
    const canceled = await lifecycle.cancel(cancellation);
    expect(canceled.status).toBe('withdrawn');
    expect(await lifecycle.cancel(cancellation)).toEqual(canceled);
    await expect(
      lifecycle.cancel({ ...cancellation, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CANCELLATION_ALREADY_RECORDED' });

    await createWithOrg(database)(context, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ settings: { waitlistMode: 'manual' } })
        .where('org_id', '=', orgId)
        .where('id', '=', secondProgramId)
        .execute();
      await trx
        .updateTable('registration_offerings')
        .set({ waitlist_enabled: true })
        .where('org_id', '=', orgId)
        .where('id', '=', secondOfferingId)
        .execute();
      await trx
        .updateTable('capacity_counters')
        .set({ confirmed: 1 })
        .where('org_id', '=', orgId)
        .where('subject_type', '=', 'offering')
        .where('subject_id', '=', secondOfferingId)
        .execute();
    });
    const waitlist = await lifecycle.joinWaitlist({
      orgId,
      offeringId: secondOfferingId,
      personId,
      householdId,
    });
    expect(
      await lifecycle.joinWaitlist({
        orgId,
        offeringId: secondOfferingId,
        personId,
        householdId,
      }),
    ).toEqual(waitlist);
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('capacity_counters')
        .set({ confirmed: 0 })
        .where('org_id', '=', orgId)
        .where('subject_type', '=', 'offering')
        .where('subject_id', '=', secondOfferingId)
        .execute(),
    );
    const offerKey = randomUUID();
    const offer = await lifecycle.offerWaitlist({
      orgId,
      offeringId: secondOfferingId,
      entryId: waitlist.id,
      idempotencyKey: offerKey,
    });
    if (typeof offer === 'string')
      throw new Error(`Waitlist offer failed: ${offer}`);
    expect(
      await lifecycle.offerWaitlist({
        orgId,
        offeringId: secondOfferingId,
        entryId: waitlist.id,
        idempotencyKey: offerKey,
      }),
    ).toEqual(offer);
    const acceptedOffer = await lifecycle.acceptWaitlist({
      orgId,
      entryId: waitlist.id,
    });
    expect(acceptedOffer.checkoutId).toMatch(/^[0-9a-f-]{36}$/i);
    const accepted = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('waitlist_entries')
        .select(['accepted_at', 'status'])
        .where('org_id', '=', orgId)
        .where('id', '=', waitlist.id)
        .executeTakeFirstOrThrow(),
    );
    expect(accepted.accepted_at).toBeTruthy();
    expect(accepted.status).toBe('offered');
  });
});
