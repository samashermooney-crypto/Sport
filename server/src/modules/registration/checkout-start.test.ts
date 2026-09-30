import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { newId } from '@shared/ids';
import express from 'express';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg } from '../../db/withOrg.js';
import { decryptRestricted, type EncryptionKeys } from '../../lib/crypto.js';
import type { AuthDependencies } from '../auth/routes.js';

import { PostgresRegistrationCheckoutQuote } from './checkout-quote.js';
import { PostgresRegistrationCheckoutStart } from './checkout-start.js';
import {
  PostgresRegistrationLifecycle,
  registrationCancelResponseSchema,
  waitlistEntrySchema,
} from './lifecycle.js';
import { PostgresCheckoutPolicyAcceptance } from './policy-acceptance.js';
import { PostgresRegistrationReports } from './reports.js';
import {
  PostgresRegistrationRequirements,
  waiverDocumentHash,
} from './requirements.js';
import { createRegistrationRouter } from './routes.js';
import { teamEntrySchema } from './team-entries.js';

let database: Kysely<DB>;
const accountId = newId();
const otherAccountId = newId();
const staffAccountId = newId();
const directorAccountId = newId();
const orgId = newId();
const personId = newId();
const householdId = newId();
const programId = newId();
const divisionId = newId();
const offeringId = newId();
const context = { orgId, actor: { accountId } };
const staffContext = { orgId, actor: { accountId: staffAccountId } };
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
let staffToken: string;
let directorToken: string;
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
      {
        id: staffAccountId,
        email: `register-staff-${randomUUID()}@example.invalid`,
        first_name: 'Registrar',
        last_name: 'One',
        date_of_birth: '1990-01-01',
      },
      {
        id: directorAccountId,
        email: `register-director-${randomUUID()}@example.invalid`,
        first_name: 'Program',
        last_name: 'Director',
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
    await trx
      .insertInto('org_memberships')
      .values([
        {
          id: newId(),
          org_id: orgId,
          account_id: staffAccountId,
          status: 'active',
        },
        {
          id: newId(),
          org_id: orgId,
          account_id: directorAccountId,
          status: 'active',
        },
      ])
      .execute();
    await trx
      .insertInto('role_assignments')
      .values([
        {
          id: newId(),
          org_id: orgId,
          account_id: staffAccountId,
          role: 'registrar',
          scope_type: 'org',
          scope_id: null,
          pending_mfa: false,
        },
        {
          id: newId(),
          org_id: orgId,
          account_id: directorAccountId,
          role: 'director',
          scope_type: 'org',
          scope_id: null,
          pending_mfa: false,
        },
      ])
      .execute();
  });
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
        registration_opens_at: new Date('2026-08-01T00:00:00.000Z'),
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
  token = randomBytes(32).toString('base64url');
  staffToken = randomBytes(32).toString('base64url');
  directorToken = randomBytes(32).toString('base64url');
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
  await database
    .insertInto('sessions')
    .values({
      id: newId(),
      account_id: staffAccountId,
      token_hash: createHash('sha256').update(staffToken).digest(),
      kind: 'cookie',
      client: 'web',
      privileged: false,
      idle_expires_at: new Date(Date.now() + 60 * 60_000),
      absolute_expires_at: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .execute();
  await database
    .insertInto('sessions')
    .values({
      id: newId(),
      account_id: directorAccountId,
      token_hash: createHash('sha256').update(directorToken).digest(),
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
      items: {
        offeringId: string;
        status: string;
        eligibleParticipants: {
          personId: string;
          householdId: string;
          eligible: boolean;
          alreadyRegistered: boolean;
          age: number | null;
          grade: number | null;
          ageGroupLabel: string | null;
          reasons: { code: string; message: string }[];
        }[];
      }[];
    };
    expect(body.items).toMatchObject([{ offeringId, status: 'open' }]);
    expect(body.items[0]?.eligibleParticipants).toEqual([
      {
        personId,
        householdId,
        eligible: true,
        alreadyRegistered: false,
        age: 14,
        grade: null,
        ageGroupLabel: '14',
        reasons: [],
      },
    ]);
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('programs')
        .set({ eligibility: { minAge: 8, maxAge: 10 } })
        .where('org_id', '=', orgId)
        .where('id', '=', programId)
        .execute(),
    );
    const ageFiltered = await fetch(path, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
    });
    const filteredBody = (await ageFiltered.json()) as typeof body;
    expect(filteredBody.items[0]?.eligibleParticipants).toMatchObject([
      {
        personId,
        eligible: false,
        age: 14,
        reasons: [{ code: 'AGE_ABOVE_MAX' }],
      },
    ]);
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('programs')
        .set({ eligibility: { minAge: 8, maxAge: 16 } })
        .where('org_id', '=', orgId)
        .where('id', '=', programId)
        .execute(),
    );
    const family = await fetch(`${baseUrl}/orgs/${orgId}/participants`, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
    });
    expect(family.status).toBe(200);
    expect(await family.json()).toMatchObject({
      people: [{ personId, householdId }],
    });
    const familyRegistrations = await fetch(
      `${baseUrl}/orgs/${orgId}/me/registrations`,
      { headers: { Cookie: `__Host-athlentry_session=${token}` } },
    );
    expect(familyRegistrations.status).toBe(200);
    expect(await familyRegistrations.json()).toEqual({ registrations: [] });
    const familyStaffQueue = await fetch(
      `${baseUrl}/orgs/${orgId}/registrations`,
      { headers: { Cookie: `__Host-athlentry_session=${token}` } },
    );
    expect(familyStaffQueue.status).toBe(403);
    const registrarQueue = await fetch(
      `${baseUrl}/orgs/${orgId}/registrations?status=pending_approval`,
      { headers: { Cookie: `__Host-athlentry_session=${staffToken}` } },
    );
    expect(registrarQueue.status).toBe(200);
    expect(await registrarQueue.json()).toEqual({ registrations: [] });
    const directorQueue = await fetch(
      `${baseUrl}/orgs/${orgId}/registrations`,
      { headers: { Cookie: `__Host-athlentry_session=${directorToken}` } },
    );
    expect(directorQueue.status).toBe(403);
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
        .where('subject_id', 'in', [programId, divisionId, offeringId])
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
    const familyRegistrations = await fetch(
      `${baseUrl}/orgs/${orgId}/me/registrations`,
      { headers: { Cookie: `__Host-athlentry_session=${token}` } },
    );
    expect(familyRegistrations.status).toBe(200);
    expect(await familyRegistrations.json()).toMatchObject({
      registrations: [
        {
          personId,
          programId,
          offeringId,
          status: 'pending_payment',
          invoiceId: first.invoiceId,
        },
      ],
    });
    const staffRegistrations = await fetch(
      `${baseUrl}/orgs/${orgId}/registrations?status=pending_payment`,
      { headers: { Cookie: `__Host-athlentry_session=${staffToken}` } },
    );
    expect(staffRegistrations.status).toBe(200);
    expect(await staffRegistrations.json()).toMatchObject({
      registrations: [{ invoiceId: first.invoiceId }],
    });
    const state = await createWithOrg(database)(context, async (trx) => ({
      invoice: await trx
        .selectFrom('invoices')
        .select(['total_cents', 'balance_cents', 'source'])
        .where('org_id', '=', orgId)
        .where('id', '=', first.invoiceId)
        .executeTakeFirstOrThrow(),
      registrations: await trx
        .selectFrom('registrations')
        .select(['id', 'status', 'checkout_id', 'invoice_line_id'])
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

    const registration = state.registrations[0];
    if (!registration?.invoice_line_id)
      throw new Error('Expected the quoted registration line');
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('registration_add_on_selections')
        .values({
          id: newId(),
          org_id: orgId,
          registration_id: registration.id,
          invoice_line_id: registration.invoice_line_id,
          line_key: 'uniform-kit',
          name: 'Uniform kit',
          size: 'Youth Medium',
          quantity: 2,
          unit_amount_cents: 1200,
          amount_cents: 2400,
        })
        .execute(),
    );
    const reportUrl = `${baseUrl}/orgs/${orgId}/reports/registrations?programId=${programId}&status=pending_payment`;
    const reportResponse = await fetch(reportUrl, {
      headers: { Cookie: `__Host-athlentry_session=${staffToken}` },
    });
    expect(reportResponse.status).toBe(200);
    expect(await reportResponse.json()).toMatchObject({
      total: 1,
      truncated: false,
      filters: { programId, status: 'pending_payment' },
      registrations: [
        {
          registrationId: registration.id,
          participantName: 'Maya One',
          programName: 'Fall Soccer',
          divisionName: 'Youth',
          offeringName: 'Youth player',
          status: 'pending_payment',
        },
      ],
    });
    expect(
      (
        await fetch(reportUrl, {
          headers: { Cookie: `__Host-athlentry_session=${token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/orgs/${orgId}/reports/registrations`, {
          headers: { Cookie: `__Host-athlentry_session=${directorToken}` },
        })
      ).status,
    ).toBe(403);
    const csv = await fetch(
      `${baseUrl}/orgs/${orgId}/reports/registrations.csv?programId=${programId}&status=pending_payment`,
      { headers: { Cookie: `__Host-athlentry_session=${staffToken}` } },
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('Maya One');
    const uniform = await fetch(
      `${baseUrl}/orgs/${orgId}/reports/uniform-sizes?programId=${programId}`,
      { headers: { Cookie: `__Host-athlentry_session=${staffToken}` } },
    );
    expect(uniform.status).toBe(200);
    expect(await uniform.json()).toMatchObject({
      items: [
        {
          programId,
          divisionName: 'Youth',
          addOnKey: 'uniform-kit',
          addOnName: 'Uniform kit',
          size: 'Youth Medium',
          quantity: 2,
          registrations: 1,
        },
      ],
    });
    const paceReport = await new PostgresRegistrationReports(
      database,
      staffContext,
    ).pace({ orgId, programId });
    expect(paceReport.programId).toBe(programId);
    const pace = await fetch(
      `${baseUrl}/orgs/${orgId}/reports/pace/${programId}`,
      { headers: { Cookie: `__Host-athlentry_session=${staffToken}` } },
    );
    expect(pace.status).toBe(200);
    const paceBody = z
      .strictObject({
        programId: z.uuid(),
        previousProgramId: z.uuid().nullable(),
        days: z.array(
          z.strictObject({
            dayOffset: z.number().int().nonnegative(),
            current: z.number().int().nonnegative(),
            previous: z.number().int().nonnegative().nullable(),
          }),
        ),
      })
      .parse(await pace.json());
    expect(paceBody.programId).toBe(programId);
    expect(paceBody.previousProgramId).toBeNull();
    expect(paceBody.days.some((day) => day.current === 1)).toBe(true);
    expect(paceBody.days.every((day) => day.previous === null)).toBe(true);
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
    const staffLifecycle = new PostgresRegistrationLifecycle(
      database,
      staffContext,
    );
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
        .set({
          settings: { waitlistMode: 'manual' },
          eligibility: { maxAge: 10 },
        })
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
    const waitlistJoinRequest = () =>
      fetch(`${baseUrl}/orgs/${orgId}/me/waitlist`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: 'http://127.0.0.1:5173',
          'X-Athlentry-Request': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          offeringId: secondOfferingId,
          personId,
          householdId,
        }),
      });
    const ineligibleJoinResponse = await waitlistJoinRequest();
    expect(ineligibleJoinResponse.status).toBe(409);
    expect(await ineligibleJoinResponse.json()).toMatchObject({
      error: { code: 'INELIGIBLE' },
    });
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ eligibility: { minAge: 8, maxAge: 16 } })
        .where('org_id', '=', orgId)
        .where('id', '=', secondProgramId)
        .execute();
    });
    const joinResponse = await waitlistJoinRequest();
    expect(joinResponse.status).toBe(201);
    const waitlist = waitlistEntrySchema.parse(await joinResponse.json());
    expect(
      await lifecycle.joinWaitlist({
        orgId,
        offeringId: secondOfferingId,
        personId,
        householdId,
      }),
    ).toEqual(waitlist);
    const familyWaitlist = await fetch(`${baseUrl}/orgs/${orgId}/me/waitlist`, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
    });
    expect(familyWaitlist.status).toBe(200);
    expect(await familyWaitlist.json()).toMatchObject({
      entries: [{ id: waitlist.id, personId, position: 1, status: 'waiting' }],
    });
    const staffWaitlist = await fetch(
      `${baseUrl}/orgs/${orgId}/waitlist?offeringId=${secondOfferingId}`,
      { headers: { Cookie: `__Host-athlentry_session=${staffToken}` } },
    );
    expect(staffWaitlist.status).toBe(200);
    expect(await staffWaitlist.json()).toMatchObject({
      entries: [{ id: waitlist.id, personId, position: 1, status: 'waiting' }],
    });
    const familyStaffWaitlist = await fetch(
      `${baseUrl}/orgs/${orgId}/waitlist?offeringId=${secondOfferingId}`,
      { headers: { Cookie: `__Host-athlentry_session=${token}` } },
    );
    expect(familyStaffWaitlist.status).toBe(403);
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
    const familyOffer = await fetch(
      `${baseUrl}/orgs/${orgId}/waitlist/offers`,
      {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: 'http://127.0.0.1:5173',
          'X-Athlentry-Request': '1',
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          offeringId: secondOfferingId,
          entryId: waitlist.id,
        }),
      },
    );
    expect(familyOffer.status).toBe(403);
    const offerResponse = await fetch(
      `${baseUrl}/orgs/${orgId}/waitlist/offers`,
      {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${staffToken}`,
          Origin: 'http://127.0.0.1:5173',
          'X-Athlentry-Request': '1',
          'Idempotency-Key': offerKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          offeringId: secondOfferingId,
          entryId: waitlist.id,
        }),
      },
    );
    expect(offerResponse.status).toBe(200);
    const offer = z
      .strictObject({ entryId: z.uuid(), expiresAt: z.iso.datetime() })
      .parse(await offerResponse.json());
    expect(offer.entryId).toBe(waitlist.id);
    expect(
      await staffLifecycle.offerWaitlist({
        orgId,
        offeringId: secondOfferingId,
        entryId: waitlist.id,
        idempotencyKey: offerKey,
      }),
    ).toEqual(offer);
    const acceptResponse = await fetch(
      `${baseUrl}/orgs/${orgId}/me/waitlist/${waitlist.id}/accept`,
      {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: 'http://127.0.0.1:5173',
          'X-Athlentry-Request': '1',
        },
      },
    );
    expect(acceptResponse.status).toBe(200);
    const acceptedOffer = z
      .strictObject({ checkoutId: z.uuid() })
      .parse(await acceptResponse.json());
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

  it('routes adult team entry, captain invitations, and registrar approval through scoped HTTP endpoints', async () => {
    const captainPersonId = newId();
    const teamOfferingId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .updateTable('accounts')
        .set({ email_verified_at: new Date() })
        .where('id', '=', accountId)
        .execute();
      await trx
        .insertInto('people')
        .values({
          id: captainPersonId,
          org_id: orgId,
          first_name: 'Jordan',
          last_name: 'Captain',
          date_of_birth: '1980-03-10',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: orgId,
          person_id: captainPersonId,
          account_id: accountId,
          relationship: 'self',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .updateTable('capacity_counters')
        .set({ capacity: 20 })
        .where('org_id', '=', orgId)
        .where('subject_type', 'in', ['program', 'division'])
        .execute();
      await trx
        .insertInto('registration_offerings')
        .values({
          id: teamOfferingId,
          org_id: orgId,
          program_id: programId,
          division_id: divisionId,
          name: 'Adult team entry',
          registrant_role: 'team_entry',
          price_cents: 0,
          capacity: 20,
          waitlist_enabled: false,
          requires_approval: true,
          visibility: 'public',
          active: true,
        })
        .execute();
      await trx
        .insertInto('capacity_counters')
        .values({
          id: newId(),
          org_id: orgId,
          subject_type: 'offering',
          subject_id: teamOfferingId,
          capacity: 20,
        })
        .execute();
    });

    const familyHeaders = {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: 'http://127.0.0.1:5173',
      'X-Athlentry-Request': '1',
      'Content-Type': 'application/json',
    };
    const options = await fetch(`${baseUrl}/orgs/${orgId}/team-entry-options`, {
      headers: { Cookie: familyHeaders.Cookie },
    });
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({
      offerings: [{ offeringId: teamOfferingId, requiresApproval: true }],
      captains: [{ personId: captainPersonId, name: 'Jordan Captain' }],
    });

    const createBody = {
      offeringId: teamOfferingId,
      captainPersonId,
      teamName: 'Northside Adult United',
      clubName: 'Northside',
      seedHint: 4,
    };
    const rejectedOrigin = await fetch(
      `${baseUrl}/orgs/${orgId}/team-entries`,
      {
        method: 'POST',
        headers: { ...familyHeaders, Origin: 'https://not-the-app.example' },
        body: JSON.stringify(createBody),
      },
    );
    expect(rejectedOrigin.status).toBe(403);
    const created = await fetch(`${baseUrl}/orgs/${orgId}/team-entries`, {
      method: 'POST',
      headers: { ...familyHeaders, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(201);
    const team = teamEntrySchema.parse(await created.json());
    expect(team).toMatchObject({
      teamName: 'Northside Adult United',
      status: 'pending_approval',
      captainPersonId,
    });

    const inviteEmail = `adult-player-${randomUUID()}@example.invalid`;
    const invited = await fetch(
      `${baseUrl}/orgs/${orgId}/team-entries/${team.id}/invites`,
      {
        method: 'POST',
        headers: { ...familyHeaders, 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ emails: [inviteEmail] }),
      },
    );
    expect(invited.status).toBe(201);
    const invite = z
      .strictObject({
        invites: z.array(
          z.strictObject({
            id: z.uuid(),
            email: z.email(),
            expiresAt: z.iso.datetime(),
            inviteUrl: z.url(),
          }),
        ),
      })
      .parse(await invited.json()).invites[0];
    if (!invite) throw new Error('Team invitation was not returned');
    expect(invite.email).toBe(inviteEmail);
    expect(new URL(invite.inviteUrl).pathname).toContain(
      `/portal/orgs/${orgId}/team-entry-invites/`,
    );

    const captainInvites = await fetch(
      `${baseUrl}/orgs/${orgId}/team-entries/${team.id}/invites`,
      { headers: { Cookie: familyHeaders.Cookie } },
    );
    expect(captainInvites.status).toBe(200);
    expect(await captainInvites.json()).toMatchObject({
      invites: [{ id: invite.id, email: inviteEmail, status: 'pending' }],
    });
    const staffList = await fetch(`${baseUrl}/orgs/${orgId}/team-entries`, {
      headers: { Cookie: `__Host-athlentry_session=${staffToken}` },
    });
    expect(staffList.status).toBe(200);
    expect(await staffList.json()).toMatchObject({
      entries: [{ id: team.id, status: 'pending_approval' }],
    });

    const approval = await fetch(
      `${baseUrl}/orgs/${orgId}/team-entries/${team.id}/approval`,
      {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${staffToken}`,
          Origin: 'http://127.0.0.1:5173',
          'X-Athlentry-Request': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approved', note: 'Roster verified' }),
      },
    );
    expect(approval.status).toBe(200);
    expect(await approval.json()).toEqual({ status: 'accepted' });
    const captainEntries = await fetch(
      `${baseUrl}/orgs/${orgId}/me/team-entries`,
      { headers: { Cookie: familyHeaders.Cookie } },
    );
    expect(captainEntries.status).toBe(200);
    expect(await captainEntries.json()).toMatchObject({
      entries: [{ id: team.id, status: 'accepted', inviteCount: 1 }],
    });
    const counters = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('capacity_counters')
        .select(['subject_type', 'confirmed', 'held'])
        .where('org_id', '=', orgId)
        .where('subject_id', 'in', [programId, divisionId, teamOfferingId])
        .execute(),
    );
    expect(counters).toHaveLength(3);
    const teamOfferingCounter = counters.find(
      (counter) => counter.subject_type === 'offering' && counter.held === 0,
    );
    expect(teamOfferingCounter).toMatchObject({ confirmed: 1, held: 0 });
  });

  it('limits cancellation previews by ownership and replays family and staff cancellations exactly', async () => {
    const householdForCancellation = newId();
    const familyPersonId = newId();
    const staffPersonId = newId();
    const familyRegistrationId = newId();
    const staffRegistrationId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('households')
        .values({
          id: householdForCancellation,
          org_id: orgId,
          name: 'Cancellation household',
        })
        .execute();
      await trx
        .insertInto('people')
        .values([
          {
            id: familyPersonId,
            org_id: orgId,
            first_name: 'Family',
            last_name: 'Cancel',
            date_of_birth: '2012-04-01',
          },
          {
            id: staffPersonId,
            org_id: orgId,
            first_name: 'Staff',
            last_name: 'Cancel',
            date_of_birth: '2013-05-02',
          },
        ])
        .execute();
      await trx
        .insertInto('household_members')
        .values([
          {
            id: newId(),
            org_id: orgId,
            household_id: householdForCancellation,
            person_id: familyPersonId,
            role: 'athlete',
          },
          {
            id: newId(),
            org_id: orgId,
            household_id: householdForCancellation,
            person_id: staffPersonId,
            role: 'athlete',
          },
        ])
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: orgId,
          person_id: familyPersonId,
          account_id: accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('registrations')
        .values([
          {
            id: familyRegistrationId,
            org_id: orgId,
            program_id: programId,
            division_id: divisionId,
            offering_id: offeringId,
            person_id: familyPersonId,
            household_id: householdForCancellation,
            registered_by_account_id: accountId,
            source: 'online',
            status: 'confirmed',
          },
          {
            id: staffRegistrationId,
            org_id: orgId,
            program_id: programId,
            division_id: divisionId,
            offering_id: offeringId,
            person_id: staffPersonId,
            household_id: householdForCancellation,
            registered_by_account_id: accountId,
            source: 'staff',
            status: 'confirmed',
          },
        ])
        .execute();
      await trx
        .updateTable('capacity_counters')
        .set({ confirmed: 2, held: 0, capacity: 20 })
        .where('org_id', '=', orgId)
        .where('subject_id', 'in', [programId, divisionId, offeringId])
        .execute();
    });

    const familyPreview = await fetch(
      `${baseUrl}/orgs/${orgId}/me/registrations/${familyRegistrationId}/cancellation-preview`,
      { headers: { Cookie: `__Host-athlentry_session=${token}` } },
    );
    expect(familyPreview.status).toBe(200);
    expect(await familyPreview.json()).toBeNull();
    const staffPreview = await fetch(
      `${baseUrl}/orgs/${orgId}/registrations/${familyRegistrationId}/cancellation-preview`,
      { headers: { Cookie: `__Host-athlentry_session=${staffToken}` } },
    );
    expect(staffPreview.status).toBe(200);
    expect(await staffPreview.json()).toBeNull();
    const unrelatedFamilyPreview = await fetch(
      `${baseUrl}/orgs/${orgId}/me/registrations/${familyRegistrationId}/cancellation-preview`,
      { headers: { Cookie: `__Host-athlentry_session=${directorToken}` } },
    );
    expect(unrelatedFamilyPreview.status).toBe(403);
    const unauthorizedStaffPreview = await fetch(
      `${baseUrl}/orgs/${orgId}/registrations/${familyRegistrationId}/cancellation-preview`,
      { headers: { Cookie: `__Host-athlentry_session=${directorToken}` } },
    );
    expect(unauthorizedStaffPreview.status).toBe(403);

    const familyCancelHeaders = {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: 'http://127.0.0.1:5173',
      'X-Athlentry-Request': '1',
      'Idempotency-Key': randomUUID(),
      'Content-Type': 'application/json',
    };
    const familyCancel = await fetch(
      `${baseUrl}/orgs/${orgId}/me/registrations/${familyRegistrationId}/cancel`,
      {
        method: 'POST',
        headers: familyCancelHeaders,
        body: JSON.stringify({ reason: 'Family schedule changed' }),
      },
    );
    expect(familyCancel.status).toBe(200);
    const familyResult = registrationCancelResponseSchema.parse(
      await familyCancel.json(),
    );
    expect(familyResult).toEqual({ status: 'withdrawn', refundProposal: null });
    const familyReplay = await fetch(
      `${baseUrl}/orgs/${orgId}/me/registrations/${familyRegistrationId}/cancel`,
      {
        method: 'POST',
        headers: familyCancelHeaders,
        body: JSON.stringify({ reason: 'Family schedule changed' }),
      },
    );
    expect(familyReplay.status).toBe(200);
    expect(
      registrationCancelResponseSchema.parse(await familyReplay.json()),
    ).toEqual(familyResult);
    const changedFamilyReplay = await fetch(
      `${baseUrl}/orgs/${orgId}/me/registrations/${familyRegistrationId}/cancel`,
      {
        method: 'POST',
        headers: { ...familyCancelHeaders, 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ reason: 'Changed plans again' }),
      },
    );
    expect(changedFamilyReplay.status).toBe(409);
    expect(await changedFamilyReplay.json()).toMatchObject({
      error: { code: 'CANCELLATION_ALREADY_RECORDED' },
    });

    const staffCancel = await fetch(
      `${baseUrl}/orgs/${orgId}/registrations/${staffRegistrationId}/cancel`,
      {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${staffToken}`,
          Origin: 'http://127.0.0.1:5173',
          'X-Athlentry-Request': '1',
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Registrar correction' }),
      },
    );
    expect(staffCancel.status).toBe(200);
    expect(
      registrationCancelResponseSchema.parse(await staffCancel.json()),
    ).toEqual({
      status: 'canceled',
      refundProposal: null,
    });
    const balances = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('capacity_counters')
        .select(['subject_type', 'confirmed', 'held'])
        .where('org_id', '=', orgId)
        .where('subject_id', 'in', [programId, divisionId, offeringId])
        .execute(),
    );
    expect(balances).toHaveLength(3);
    expect(balances.every((counter) => counter.confirmed === 0)).toBe(true);
  });

  it('requires registrar approval before payment and honors its deadline and idempotency key', async () => {
    const approvalProgramId = newId();
    const approvalDivisionId = newId();
    const approvalOfferingId = newId();
    const lineId = newId();
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
          id: approvalProgramId,
          org_id: orgId,
          season_id: source.season_id,
          sport_profile_id: source.sport_profile_id,
          mode: 'league',
          name: 'Approval registration',
          slug: `approval-${randomUUID().slice(0, 8)}`,
          status: 'registration_open',
          visibility: 'public',
          starts_on: '2026-09-01',
          ends_on: '2026-12-01',
          settings: { paymentDueHours: 48, approvalDecisionHours: 72 },
        })
        .execute();
      await trx
        .insertInto('divisions')
        .values({
          id: approvalDivisionId,
          org_id: orgId,
          program_id: approvalProgramId,
          name: 'Approval group',
        })
        .execute();
      await trx
        .insertInto('registration_offerings')
        .values({
          id: approvalOfferingId,
          org_id: orgId,
          program_id: approvalProgramId,
          division_id: approvalDivisionId,
          name: 'Approval required player',
          registrant_role: 'athlete',
          price_cents: 2500,
          visibility: 'public',
          active: true,
          capacity: 1,
          requires_approval: true,
        })
        .execute();
      await trx
        .insertInto('capacity_counters')
        .values([
          {
            id: newId(),
            org_id: orgId,
            subject_type: 'program',
            subject_id: approvalProgramId,
            capacity: 1,
          },
          {
            id: newId(),
            org_id: orgId,
            subject_type: 'division',
            subject_id: approvalDivisionId,
            capacity: 1,
          },
          {
            id: newId(),
            org_id: orgId,
            subject_type: 'offering',
            subject_id: approvalOfferingId,
            capacity: 1,
          },
        ])
        .execute();
    });

    const started = await new PostgresRegistrationCheckoutStart(
      database,
      context,
    ).start({
      orgId,
      creationKey: randomUUID(),
      cart: {
        offerings: [
          { lineId, offeringId: approvalOfferingId, personId, householdId },
        ],
      },
    });
    const requirements = new PostgresRegistrationRequirements(
      database,
      context,
      encryption,
    );
    await requirements.submit({
      orgId,
      checkoutId: started.checkoutId,
      requirements: {
        version: 1,
        lines: [{ lineId, addOns: [], volunteer: 'none' }],
        forms: [],
        waivers: [],
        discountCodes: [],
        applyCreditCents: 0,
        planTemplateId: null,
        chargeOnApprovalMethodId: null,
      },
      userAgent: 'Vitest',
      ip: null,
    });
    const policy = new PostgresCheckoutPolicyAcceptance(database, context);
    const review = await policy.review(started.checkoutId);
    await policy.accept(started.checkoutId, review.termsHash, 'Vitest');
    const quote = await new PostgresRegistrationCheckoutQuote(
      database,
      context,
      encryption,
    ).quote({ orgId, checkoutId: started.checkoutId, quoteKey: randomUUID() });
    expect(quote).toMatchObject({
      totalCents: 2500,
      pendingApproval: true,
      paidInFull: false,
    });

    const registration = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('registrations')
        .select(['id', 'status'])
        .where('org_id', '=', orgId)
        .where('checkout_id', '=', started.checkoutId)
        .executeTakeFirstOrThrow(),
    );
    expect(registration.status).toBe('pending_approval');
    const decisionKey = randomUUID();
    const approvalUrl = `${baseUrl}/orgs/${orgId}/registrations/${registration.id}/approval`;
    const postApproval = (sessionToken: string, note: string) =>
      fetch(approvalUrl, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${sessionToken}`,
          Origin: 'http://127.0.0.1:5173',
          'X-Athlentry-Request': '1',
          'Idempotency-Key': decisionKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approved', note }),
      });
    expect((await postApproval(token, 'Roster verified')).status).toBe(403);

    const beforeApproval = Date.now();
    const approved = await postApproval(staffToken, 'Roster verified');
    expect(approved.status).toBe(200);
    const approvalBody = (await approved.json()) as {
      status: string;
      paymentDueAt: string | null;
    };
    expect(approvalBody.status).toBe('pending_payment');
    expect(approvalBody.paymentDueAt).toBeTruthy();
    const expectedDueAt = new Date(
      new Date(approvalBody.paymentDueAt ?? '').getTime(),
    );
    expect(expectedDueAt.getTime()).toBeGreaterThanOrEqual(
      beforeApproval + 48 * 3_600_000,
    );
    expect(expectedDueAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 48 * 3_600_000,
    );
    const replay = await postApproval(staffToken, 'Roster verified');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(approvalBody);
    const changedReplay = await postApproval(
      staffToken,
      'Different decision note',
    );
    expect(changedReplay.status).toBe(409);
    expect(await changedReplay.json()).toMatchObject({
      error: { code: 'DECISION_ALREADY_RECORDED' },
    });

    const persisted = await createWithOrg(database)(context, async (trx) => ({
      registration: await trx
        .selectFrom('registrations')
        .select(['status', 'approval_payment_due_at'])
        .where('org_id', '=', orgId)
        .where('id', '=', registration.id)
        .executeTakeFirstOrThrow(),
      hold: await trx
        .selectFrom('capacity_holds')
        .select(['expires_at', 'released_at', 'converted_at'])
        .where('org_id', '=', orgId)
        .where('checkout_id', '=', started.checkoutId)
        .executeTakeFirstOrThrow(),
      counter: await trx
        .selectFrom('capacity_counters')
        .select(['held', 'confirmed'])
        .where('org_id', '=', orgId)
        .where('subject_type', '=', 'offering')
        .where('subject_id', '=', approvalOfferingId)
        .executeTakeFirstOrThrow(),
    }));
    expect(persisted.registration.status).toBe('pending_payment');
    expect(persisted.registration.approval_payment_due_at?.toISOString()).toBe(
      approvalBody.paymentDueAt,
    );
    expect(persisted.hold.expires_at.toISOString()).toBe(
      approvalBody.paymentDueAt,
    );
    expect(persisted.hold).toMatchObject({
      released_at: null,
      converted_at: null,
    });
    expect(persisted.counter).toEqual({ held: 1, confirmed: 0 });
  });
});
