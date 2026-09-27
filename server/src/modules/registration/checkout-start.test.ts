import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { newId } from '@shared/ids';
import express from 'express';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg } from '../../db/withOrg.js';
import type { AuthDependencies } from '../auth/routes.js';

import { PostgresRegistrationCheckoutStart } from './checkout-start.js';
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
});
