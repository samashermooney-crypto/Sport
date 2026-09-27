import { randomUUID } from 'node:crypto';

import { serviceFee } from '@shared/algorithms/fees';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB, Json } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresCheckoutPricingRepository } from './pricing-repo.js';
import { PostgresBasicCheckoutPricingSource } from './pricing-source-repo.js';
import { CheckoutPricingService } from './pricing.js';

let database: Kysely<DB>;
let context: OrgContext;
let checkoutId: string;
let athleteId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  const seasonId = newId();
  const sportId = newId();
  const programId = newId();
  const offeringId = newId();
  const guardianId = newId();
  athleteId = newId();
  const householdId = newId();
  checkoutId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `price-source-${randomUUID()}@example.invalid`,
      first_name: 'Price',
      last_name: 'Source',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `price-source-${randomUUID().slice(0, 8)}`,
      name: 'Price Source Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, async (trx) => {
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
        name: 'Program',
        slug: `price-${randomUUID().slice(0, 8)}`,
        starts_on: '2026-01-01',
        ends_on: '2027-12-31',
        status: 'registration_open',
        visibility: 'public',
      })
      .execute();
    await trx
      .insertInto('registration_offerings')
      .values({
        id: offeringId,
        org_id: orgId,
        program_id: programId,
        name: 'Base',
        registrant_role: 'athlete',
        price_cents: 1999,
        active: true,
        visibility: 'public',
      })
      .execute();
    await trx
      .insertInto('people')
      .values([
        {
          id: guardianId,
          org_id: orgId,
          first_name: 'Parent',
          last_name: 'Example',
          date_of_birth: '1990-01-01',
        },
        {
          id: athleteId,
          org_id: orgId,
          first_name: 'Child',
          last_name: 'Example',
          date_of_birth: '2015-01-01',
        },
      ])
      .execute();
    await trx
      .insertInto('households')
      .values({
        id: householdId,
        org_id: orgId,
        name: 'Example',
      })
      .execute();
    await trx
      .insertInto('household_members')
      .values([
        {
          id: newId(),
          org_id: orgId,
          household_id: householdId,
          person_id: guardianId,
          role: 'guardian',
          financially_responsible: true,
        },
        {
          id: newId(),
          org_id: orgId,
          household_id: householdId,
          person_id: athleteId,
          role: 'athlete',
        },
      ])
      .execute();
    await trx
      .insertInto('person_account_links')
      .values({
        id: newId(),
        org_id: orgId,
        person_id: guardianId,
        account_id: accountId,
        relationship: 'self',
        verified_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: orgId,
        account_id: accountId,
        expires_at: new Date(Date.now() + 1_200_000),
        items: {
          offerings: [
            { lineId: newId(), offeringId, personId: athleteId, householdId },
          ],
        },
      })
      .execute();
    await trx
      .insertInto('capacity_holds')
      .values([
        {
          id: newId(),
          org_id: orgId,
          checkout_id: checkoutId,
          subject_type: 'program',
          subject_id: programId,
          quantity: 1,
          expires_at: new Date(Date.now() + 1_200_000),
        },
        {
          id: newId(),
          org_id: orgId,
          checkout_id: checkoutId,
          subject_type: 'offering',
          subject_id: offeringId,
          quantity: 1,
          expires_at: new Date(Date.now() + 1_200_000),
        },
      ])
      .execute();
  });
});

afterAll(async () => {
  await database.destroy();
});

describe('basic checkout pricing source', () => {
  it('freezes the database offering price and rejects a later key', async () => {
    const service = new CheckoutPricingService(
      new PostgresCheckoutPricingRepository(
        database,
        context,
        new PostgresBasicCheckoutPricingSource(),
      ),
    );
    await expect(
      service.freeze({
        orgId: context.orgId,
        checkoutId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('Registration pricing source is unavailable');
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: context.orgId,
          person_id: athleteId,
          account_id: context.actor.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute(),
    );
    const ruleId = newId();
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('automatic_discount_rules')
        .values({
          id: ruleId,
          org_id: context.orgId,
          kind: 'sibling',
          active: true,
        })
        .execute(),
    );
    await expect(
      service.freeze({
        orgId: context.orgId,
        checkoutId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('Active discounts');
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('automatic_discount_rules')
        .set({ active: false })
        .where('org_id', '=', context.orgId)
        .where('id', '=', ruleId)
        .execute(),
    );
    const first = await service.freeze({
      orgId: context.orgId,
      checkoutId,
      idempotencyKey: randomUUID(),
    });
    expect(first.snapshot.subtotalCents).toBe(1999);
    expect(first.snapshot.chargeNowCents).toBe(1999);
    await expect(
      service.freeze({
        orgId: context.orgId,
        checkoutId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('another key');

    const freezeWithSetting = async (setting: unknown) => {
      const nextCheckoutId = newId();
      await createWithOrg(database)(context, async (trx) => {
        const firstCheckout = await trx
          .selectFrom('checkouts')
          .select(['items', 'account_id'])
          .where('org_id', '=', context.orgId)
          .where('id', '=', checkoutId)
          .executeTakeFirstOrThrow();
        const holds = await trx
          .selectFrom('capacity_holds')
          .select(['subject_type', 'subject_id', 'quantity'])
          .where('org_id', '=', context.orgId)
          .where('checkout_id', '=', checkoutId)
          .execute();
        await trx
          .updateTable('organizations')
          .set({
            settings: setting as Json,
            application_fee_bps: 150,
            application_fee_fixed_cents: 20,
          })
          .where('id', '=', context.orgId)
          .execute();
        await trx
          .insertInto('checkouts')
          .values({
            id: nextCheckoutId,
            org_id: context.orgId,
            account_id: firstCheckout.account_id,
            expires_at: new Date(Date.now() + 1_200_000),
            items: firstCheckout.items,
          })
          .execute();
        await trx
          .insertInto('capacity_holds')
          .values(
            holds.map((hold) => ({
              id: newId(),
              org_id: context.orgId,
              checkout_id: nextCheckoutId,
              subject_type: hold.subject_type,
              subject_id: hold.subject_id,
              quantity: hold.quantity,
              expires_at: new Date(Date.now() + 1_200_000),
            })),
          )
          .execute();
      });
      return service.freeze({
        orgId: context.orgId,
        checkoutId: nextCheckoutId,
        idempotencyKey: randomUUID(),
      });
    };
    const cover = await freezeWithSetting({
      serviceFee: { enabled: true, mode: 'cover_costs' },
    });
    expect(cover.snapshot.serviceFeeCents).toBe(
      serviceFee(1999, {
        enabled: true,
        mode: 'cover_costs',
        application: { bps: 150, fixedCents: 20 },
        processing: { bps: 290, fixedCents: 30 },
      }),
    );
    expect(cover.snapshot.invoiceTotalCents).toBe(
      1999 + cover.snapshot.serviceFeeCents,
    );
    const coverStored = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('checkouts')
        .select('pricing_snapshot')
        .where('org_id', '=', context.orgId)
        .where('id', '=', cover.checkoutId)
        .executeTakeFirstOrThrow(),
    );
    expect(coverStored.pricing_snapshot).toMatchObject({
      paymentTerms: {
        applicationRate: { bps: 150, fixedCents: 20 },
        serviceFee: { enabled: true, mode: 'cover_costs' },
      },
    });
    const custom = await freezeWithSetting({
      serviceFee: {
        enabled: true,
        mode: 'custom',
        custom_bps: 175,
        custom_fixed_cents: 12,
      },
    });
    expect(custom.snapshot.serviceFeeCents).toBe(
      serviceFee(1999, {
        enabled: true,
        mode: 'custom',
        custom: { bps: 175, fixedCents: 12 },
      }),
    );
    const customStored = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('checkouts')
        .select('pricing_snapshot')
        .where('org_id', '=', context.orgId)
        .where('id', '=', custom.checkoutId)
        .executeTakeFirstOrThrow(),
    );
    expect(customStored.pricing_snapshot).toMatchObject({
      paymentTerms: {
        applicationRate: { bps: 150, fixedCents: 20 },
        serviceFee: {
          enabled: true,
          mode: 'custom',
          custom: { bps: 175, fixedCents: 12 },
        },
      },
    });
    await expect(freezeWithSetting({ unknownPricing: true })).rejects.toThrow(
      'Configured organization pricing needs a supported source loader',
    );
  });
});
