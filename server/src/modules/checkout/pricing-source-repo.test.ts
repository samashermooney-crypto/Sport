import { randomUUID } from 'node:crypto';

import { applicationFee, serviceFee } from '@shared/algorithms/fees';
import { newId } from '@shared/ids';
import { percentOf } from '@shared/money';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB, Json } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { PostgresInvoiceRepository } from '../finance/invoice-repo.js';

import { PostgresCheckoutInvoiceLinker } from './invoice-link-repo.js';
import { PostgresCheckoutPricingRepository } from './pricing-repo.js';
import { PostgresBasicCheckoutPricingSource } from './pricing-source-repo.js';
import { CheckoutPricingService } from './pricing.js';

let database: Kysely<DB>;
let context: OrgContext;
let checkoutId: string;
let athleteId: string;
let programId: string;
let offeringId: string;
let householdId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  const seasonId = newId();
  const sportId = newId();
  programId = newId();
  offeringId = newId();
  const guardianId = newId();
  athleteId = newId();
  householdId = newId();
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
    ).rejects.toThrow('Sibling discount configuration is unsupported');
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
    const coverTotal = cover.snapshot.invoiceTotalCents;
    const estimatedProcessorFee = percentOf(coverTotal, 290) + 30;
    const coveredApplicationFee = applicationFee(coverTotal, {
      bps: 150,
      fixedCents: 20,
    });
    expect(
      Math.abs(
        coverTotal - coveredApplicationFee - estimatedProcessorFee - 1999,
      ),
    ).toBeLessThanOrEqual(1);
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

  it('prices a sibling rule from the locked org source for one household', async () => {
    const secondAthleteId = newId();
    const siblingCheckoutId = newId();
    const ruleId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .updateTable('organizations')
        .set({ settings: {} })
        .where('id', '=', context.orgId)
        .execute();
      await trx
        .insertInto('people')
        .values({
          id: secondAthleteId,
          org_id: context.orgId,
          first_name: 'Sibling',
          last_name: 'Example',
          date_of_birth: '2016-01-01',
        })
        .execute();
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: context.orgId,
          household_id: householdId,
          person_id: secondAthleteId,
          role: 'athlete',
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: newId(),
          org_id: context.orgId,
          person_id: secondAthleteId,
          account_id: context.actor.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('automatic_discount_rules')
        .values({
          id: ruleId,
          org_id: context.orgId,
          kind: 'sibling',
          config: { second_bps: 1000, third_plus_bps: 1500 },
          priority: 1,
          active: true,
        })
        .execute();
      await trx
        .insertInto('checkouts')
        .values({
          id: siblingCheckoutId,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          expires_at: new Date(Date.now() + 1_200_000),
          items: {
            offerings: [
              { lineId: newId(), offeringId, personId: athleteId, householdId },
              {
                lineId: newId(),
                offeringId,
                personId: secondAthleteId,
                householdId,
              },
            ],
          },
        })
        .execute();
      await trx
        .insertInto('capacity_holds')
        .values([
          {
            id: newId(),
            org_id: context.orgId,
            checkout_id: siblingCheckoutId,
            subject_type: 'program',
            subject_id: programId,
            quantity: 2,
            expires_at: new Date(Date.now() + 1_200_000),
          },
          {
            id: newId(),
            org_id: context.orgId,
            checkout_id: siblingCheckoutId,
            subject_type: 'offering',
            subject_id: offeringId,
            quantity: 2,
            expires_at: new Date(Date.now() + 1_200_000),
          },
        ])
        .execute();
    });
    const service = new CheckoutPricingService(
      new PostgresCheckoutPricingRepository(
        database,
        context,
        new PostgresBasicCheckoutPricingSource(),
      ),
    );
    const frozen = await service.freeze({
      orgId: context.orgId,
      checkoutId: siblingCheckoutId,
      idempotencyKey: randomUUID(),
    });
    expect(frozen.snapshot.subtotalCents).toBe(3998);
    expect(frozen.snapshot.discountCents).toBe(200);
    expect(frozen.snapshot.chargeNowCents).toBe(3798);
    expect(
      frozen.snapshot.lines.filter((line) => line.kind === 'discount'),
    ).toHaveLength(1);
    const priorPersonId = newId();
    const divisionId = newId();
    const priorInvoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'staff',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'registration',
          description: 'Earlier season price',
          amountCents: 3000,
          refundable: true,
        },
      ],
    });
    await createWithOrg(database)(context, async (trx) => {
      const invoiceLine = await trx
        .selectFrom('invoice_lines')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', priorInvoice.id)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('people')
        .values({
          id: priorPersonId,
          org_id: context.orgId,
          first_name: 'Earlier',
          last_name: 'Sibling',
          date_of_birth: '2012-01-01',
        })
        .execute();
      await trx
        .insertInto('household_members')
        .values({
          id: newId(),
          org_id: context.orgId,
          household_id: householdId,
          person_id: priorPersonId,
          role: 'athlete',
        })
        .execute();
      await trx
        .insertInto('divisions')
        .values({
          id: divisionId,
          org_id: context.orgId,
          program_id: programId,
          name: 'Earlier',
          level: 'open',
        })
        .execute();
      await trx
        .insertInto('registrations')
        .values({
          id: newId(),
          org_id: context.orgId,
          program_id: programId,
          division_id: divisionId,
          offering_id: offeringId,
          person_id: priorPersonId,
          household_id: householdId,
          registered_by_account_id: context.actor.accountId,
          source: 'staff',
          status: 'confirmed',
          invoice_line_id: invoiceLine.id,
        })
        .execute();
    });
    const nextCheckoutId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('checkouts')
        .values({
          id: nextCheckoutId,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          expires_at: new Date(Date.now() + 1_200_000),
          items: {
            offerings: [
              { lineId: newId(), offeringId, personId: athleteId, householdId },
              {
                lineId: newId(),
                offeringId,
                personId: secondAthleteId,
                householdId,
              },
            ],
          },
        })
        .execute();
      await trx
        .insertInto('capacity_holds')
        .values([
          {
            id: newId(),
            org_id: context.orgId,
            checkout_id: nextCheckoutId,
            subject_type: 'program',
            subject_id: programId,
            quantity: 2,
            expires_at: new Date(Date.now() + 1_200_000),
          },
          {
            id: newId(),
            org_id: context.orgId,
            checkout_id: nextCheckoutId,
            subject_type: 'offering',
            subject_id: offeringId,
            quantity: 2,
            expires_at: new Date(Date.now() + 1_200_000),
          },
        ])
        .execute();
    });
    const withPrior = await service.freeze({
      orgId: context.orgId,
      checkoutId: nextCheckoutId,
      idempotencyKey: randomUUID(),
    });
    expect(withPrior.snapshot.discountCents).toBe(500);
    expect(withPrior.snapshot.chargeNowCents).toBe(3498);
  });

  it('reserves the last code use, then redeems it exactly once at invoice linking', async () => {
    const codeId = newId();
    const checkoutIds = [newId(), newId()];
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .updateTable('automatic_discount_rules')
        .set({ active: false })
        .where('org_id', '=', context.orgId)
        .execute();
      await trx
        .insertInto('discount_codes')
        .values({
          id: codeId,
          org_id: context.orgId,
          code: 'SAVE10',
          kind: 'percent',
          value: 1000,
          max_redemptions: 1,
          max_per_account: 1,
          applies_to: { offeringIds: [offeringId] },
        })
        .execute();
      for (const id of checkoutIds) {
        const expiresAt = new Date(Date.now() + 1_200_000);
        await trx
          .insertInto('checkouts')
          .values({
            id,
            org_id: context.orgId,
            account_id: context.actor.accountId,
            expires_at: expiresAt,
            items: {
              offerings: [
                {
                  lineId: newId(),
                  offeringId,
                  personId: athleteId,
                  householdId,
                },
              ],
              discountCodes: ['save10'],
            },
          })
          .execute();
        await trx
          .insertInto('capacity_holds')
          .values([
            {
              id: newId(),
              org_id: context.orgId,
              checkout_id: id,
              subject_type: 'program',
              subject_id: programId,
              quantity: 1,
              expires_at: expiresAt,
            },
            {
              id: newId(),
              org_id: context.orgId,
              checkout_id: id,
              subject_type: 'offering',
              subject_id: offeringId,
              quantity: 1,
              expires_at: expiresAt,
            },
          ])
          .execute();
      }
    });
    const service = new CheckoutPricingService(
      new PostgresCheckoutPricingRepository(
        database,
        context,
        new PostgresBasicCheckoutPricingSource(),
      ),
    );
    const outcomes = await Promise.allSettled(
      checkoutIds.map((id) =>
        service.freeze({
          orgId: context.orgId,
          checkoutId: id,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    const successes = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    const failures = outcomes.filter(
      (outcome) => outcome.status === 'rejected',
    );
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(String((failures[0] as PromiseRejectedResult).reason)).toContain(
      'Discount code redemption limit reached',
    );
    const winner = (
      successes[0] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof service.freeze>>
      >
    ).value;
    expect(winner.snapshot.discountCents).toBe(200);
    expect(winner.snapshot.chargeNowCents).toBe(1799);
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'checkout',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'registration',
          description: 'Registration',
          amountCents: 1999,
          refundable: true,
        },
        {
          kind: 'discount',
          description: 'SAVE10',
          amountCents: -200,
          parentLineIndex: 0,
          refundable: false,
        },
      ],
    });
    const linker = new PostgresCheckoutInvoiceLinker(database, context);
    await linker.link(winner.checkoutId, invoice.id);
    await linker.link(winner.checkoutId, invoice.id);
    const redemption = await createWithOrg(database)(context, async (trx) => {
      const rows = await trx
        .selectFrom('discount_redemptions')
        .select([
          'discount_code_id',
          'account_id',
          'invoice_id',
          'amount_cents',
        ])
        .where('org_id', '=', context.orgId)
        .where('discount_code_id', '=', codeId)
        .execute();
      return rows;
    });
    expect(redemption).toEqual([
      {
        discount_code_id: codeId,
        account_id: context.actor.accountId,
        invoice_id: invoice.id,
        amount_cents: 200,
      },
    ]);
  });

  it('applies two stackable codes and rolls back invalid combinations', async () => {
    const id = newId();
    const codeA = newId();
    const codeB = newId();
    const codeIds = [codeA, codeB];
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('discount_codes')
        .values([
          {
            id: codeA,
            org_id: context.orgId,
            code: 'STACKA',
            kind: 'fixed',
            value: 100,
            stackable: true,
          },
          {
            id: codeB,
            org_id: context.orgId,
            code: 'STACKB',
            kind: 'fixed',
            value: 100,
            stackable: true,
          },
        ])
        .execute();
      const expiresAt = new Date(Date.now() + 1_200_000);
      await trx
        .insertInto('checkouts')
        .values({
          id,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          expires_at: expiresAt,
          items: {
            offerings: [
              { lineId: newId(), offeringId, personId: athleteId, householdId },
            ],
            discountCodes: ['stackb', 'stacka'],
          },
        })
        .execute();
      await trx
        .insertInto('capacity_holds')
        .values([
          {
            id: newId(),
            org_id: context.orgId,
            checkout_id: id,
            subject_type: 'program',
            subject_id: programId,
            quantity: 1,
            expires_at: expiresAt,
          },
          {
            id: newId(),
            org_id: context.orgId,
            checkout_id: id,
            subject_type: 'offering',
            subject_id: offeringId,
            quantity: 1,
            expires_at: expiresAt,
          },
        ])
        .execute();
    });
    const service = new CheckoutPricingService(
      new PostgresCheckoutPricingRepository(
        database,
        context,
        new PostgresBasicCheckoutPricingSource(),
      ),
    );
    const frozen = await service.freeze({
      orgId: context.orgId,
      checkoutId: id,
      idempotencyKey: randomUUID(),
    });
    expect(frozen.snapshot.discountCents).toBe(200);
    expect(frozen.snapshot.chargeNowCents).toBe(1799);
    expect(
      frozen.snapshot.lines.filter((line) => line.kind === 'discount'),
    ).toHaveLength(2);
    const reservations = await createWithOrg(database)(context, (trx) =>
      sql<{ discount_code_id: string }>`
        SELECT discount_code_id FROM discount_code_reservations
        WHERE org_id = ${context.orgId}::uuid AND checkout_id = ${id}::uuid
      `.execute(trx),
    );
    expect(reservations.rows.map((row) => row.discount_code_id).sort()).toEqual(
      [...codeIds].sort(),
    );
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'checkout',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'registration',
          description: 'Registration',
          amountCents: 1999,
          refundable: true,
        },
        {
          kind: 'discount',
          description: 'STACKA',
          amountCents: -100,
          parentLineIndex: 0,
          refundable: false,
        },
        {
          kind: 'discount',
          description: 'STACKB',
          amountCents: -100,
          parentLineIndex: 0,
          refundable: false,
        },
      ],
    });
    await new PostgresCheckoutInvoiceLinker(database, context).link(
      id,
      invoice.id,
    );
    const redemptions = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('discount_redemptions')
        .select('discount_code_id')
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', invoice.id)
        .execute(),
    );
    expect(redemptions.map((row) => row.discount_code_id).sort()).toEqual(
      [...codeIds].sort(),
    );
  });
});
