import type { ServiceFeeConfig } from '@shared/algorithms/fees';
import type { PricingInput } from '@shared/algorithms/pricing';
import { sql } from 'kysely';
import { z } from 'zod';

import type { Json } from '../../db/types.js';
import type { OrgTransaction } from '../../db/withOrg.js';
import { frozenPaymentTermsSchema } from '../finance/frozen-charge-repo.js';

import { reserveDiscountCode } from './discount-codes.js';
import type { CheckoutPricingSourceLoader } from './pricing-repo.js';

const cartSchema = z
  .object({
    offerings: z
      .array(
        z
          .object({
            lineId: z.uuid(),
            offeringId: z.uuid(),
            personId: z.uuid(),
            householdId: z.uuid(),
          })
          .strict(),
      )
      .min(1),
    discountCodes: z.array(z.string()).optional(),
    applyCreditCents: z.literal(0).optional(),
  })
  .strict();

const emptyObject = (value: Json): boolean =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0;

const orgSettingsSchema = z
  .object({
    confirmOnAchProcessing: z.boolean().optional(),
    serviceFee: z
      .discriminatedUnion('enabled', [
        z.object({ enabled: z.literal(false) }).strict(),
        z.discriminatedUnion('mode', [
          z
            .object({
              enabled: z.literal(true),
              mode: z.literal('cover_costs'),
            })
            .strict(),
          z
            .object({
              enabled: z.literal(true),
              mode: z.literal('custom'),
              custom_bps: z.number().int().nonnegative().max(10_000),
              custom_fixed_cents: z.number().int().nonnegative(),
            })
            .strict(),
        ]),
      ])
      .optional(),
  })
  .strict();

const siblingRuleSchema = z
  .object({
    second_bps: z.number().int().min(0).max(10_000),
    third_plus_bps: z.number().int().min(0).max(10_000),
  })
  .strict();

interface OfferingRow {
  id: string;
  program_id: string;
  division_id: string | null;
  visibility: string;
  person_id: string;
  household_id: string;
  price_cents: number;
  season_id: string;
  program_status: string;
  registration_opens_at: Date | null;
  registration_closes_at: Date | null;
  active: boolean;
  pricing: Json;
  add_ons: Json;
  eligibility: Json;
  settings: Json;
  access_ok: boolean;
  registration_ok: boolean;
}

/** A fail-closed source loader for unmodified, base-price registration carts. */
export class PostgresBasicCheckoutPricingSource implements CheckoutPricingSourceLoader {
  async load(
    trx: OrgTransaction,
    checkout: {
      orgId: string;
      checkoutId: string;
      accountId: string;
      items: Json;
    },
  ): Promise<{
    pricing: PricingInput;
    paymentTerms: z.output<typeof frozenPaymentTermsSchema>;
  }> {
    const cart = cartSchema.parse(checkout.items);
    if (
      new Set(cart.offerings.map((item) => item.lineId)).size !==
        cart.offerings.length ||
      new Set(
        cart.offerings.map((item) => `${item.offeringId}:${item.personId}`),
      ).size !== cart.offerings.length
    )
      throw new Error('Duplicate registration cart line');
    const organization = await trx
      .selectFrom('organizations')
      .select([
        'timezone',
        'settings',
        'application_fee_bps',
        'application_fee_fixed_cents',
      ])
      .where('id', '=', checkout.orgId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const settings = orgSettingsSchema.safeParse(organization.settings);
    if (!settings.success)
      throw new Error(
        'Configured organization pricing needs a supported source loader',
      );
    const now = new Date();
    const rows: OfferingRow[] = [];
    for (const item of cart.offerings) {
      const result = await sql<OfferingRow>`
        SELECT o.id, o.program_id, o.division_id, o.visibility,
          ${item.personId}::uuid AS person_id,
          ${item.householdId}::uuid AS household_id, o.price_cents,
          p.season_id, p.status AS program_status, p.registration_opens_at,
          p.registration_closes_at, o.active, o.pricing, o.add_ons,
          p.eligibility, p.settings,
          EXISTS (
            SELECT 1 FROM household_members athlete
            JOIN households h ON h.org_id = athlete.org_id AND h.id = athlete.household_id
            JOIN people person ON person.org_id = athlete.org_id AND person.id = athlete.person_id
            WHERE athlete.org_id = o.org_id AND athlete.person_id = ${item.personId}::uuid
              AND athlete.household_id = ${item.householdId}::uuid
              AND h.status = 'active' AND person.status = 'active'
              AND EXISTS (
                SELECT 1 FROM person_account_links pal
                WHERE pal.org_id = athlete.org_id
                  AND pal.person_id = athlete.person_id
                  AND pal.account_id = ${checkout.accountId}::uuid
                  AND pal.relationship IN ('self', 'guardian')
                  AND pal.revoked_at IS NULL
              )
          ) AS access_ok,
          EXISTS (
            SELECT 1 FROM registrations r
            WHERE r.org_id = o.org_id AND r.program_id = o.program_id
              AND r.person_id = ${item.personId}::uuid
              AND r.status NOT IN ('canceled', 'withdrawn', 'transferred_out')
          ) AS registration_ok
        FROM registration_offerings o
        JOIN programs p ON p.org_id = o.org_id AND p.id = o.program_id
        WHERE o.org_id = ${checkout.orgId}::uuid AND o.id = ${item.offeringId}::uuid
        FOR UPDATE OF o, p
      `.execute(trx);
      const row = result.rows[0];
      if (
        !row ||
        !row.access_ok ||
        row.registration_ok ||
        !row.active ||
        row.visibility !== 'public' ||
        row.program_status !== 'registration_open' ||
        (row.registration_opens_at && row.registration_opens_at > now) ||
        (row.registration_closes_at && row.registration_closes_at <= now)
      )
        throw new Error('Registration pricing source is unavailable');
      if (
        !emptyObject(row.pricing) ||
        !emptyObject(row.eligibility) ||
        !emptyObject(row.settings) ||
        !Array.isArray(row.add_ons) ||
        row.add_ons.length !== 0
      )
        throw new Error(
          'Configured offering pricing needs a supported source loader',
        );
      rows.push(row);
    }
    if (
      new Set(rows.map((row) => `${row.program_id}:${row.person_id}`)).size !==
      rows.length
    )
      throw new Error('Duplicate participant program in registration cart');
    const subjects = [
      ...rows.map((row) => ({ kind: 'program', id: row.program_id })),
      ...rows
        .filter((row) => row.division_id)
        .map((row) => ({ kind: 'division', id: row.division_id ?? '' })),
      ...rows.map((row) => ({ kind: 'offering', id: row.id })),
    ];
    for (const subject of new Set(
      subjects.map((item) => `${item.kind}:${item.id}`),
    )) {
      const [kind, id] = subject.split(':');
      const holds = await trx
        .selectFrom('capacity_holds')
        .select(['quantity', 'expires_at', 'released_at', 'converted_at'])
        .where('org_id', '=', checkout.orgId)
        .where('checkout_id', '=', checkout.checkoutId)
        .where('subject_type', '=', kind as 'program' | 'division' | 'offering')
        .where('subject_id', '=', id ?? '')
        .forUpdate()
        .execute();
      const held = holds
        .filter(
          (hold) =>
            !hold.released_at && !hold.converted_at && hold.expires_at > now,
        )
        .reduce((total, hold) => total + hold.quantity, 0);
      if (
        held <
        subjects.filter((item) => `${item.kind}:${item.id}` === subject).length
      )
        throw new Error('Registration capacity hold is unavailable');
    }
    const seasonIds = [...new Set(rows.map((row) => row.season_id))];
    await sql`LOCK TABLE automatic_discount_rules, aid_applications, tax_rates IN SHARE MODE`.execute(
      trx,
    );
    const rules = await trx
      .selectFrom('automatic_discount_rules')
      .select(['id', 'kind', 'config', 'season_id'])
      .where('org_id', '=', checkout.orgId)
      .where('active', '=', true)
      .where((eb) =>
        eb.or([eb('season_id', 'is', null), eb('season_id', 'in', seasonIds)]),
      )
      .forUpdate()
      .execute();
    let siblingRule: PricingInput['siblingRule'];
    let existingConfirmed: PricingInput['existingConfirmed'] = [];
    if (rules.length) {
      if (
        rules.length !== 1 ||
        rules[0]?.kind !== 'sibling' ||
        (rules[0].season_id &&
          seasonIds.some((id) => id !== rules[0]?.season_id)) ||
        new Set(rows.map((row) => row.household_id)).size !== 1
      )
        throw new Error('Active discounts need a supported source loader');
      const config = siblingRuleSchema.safeParse(rules[0].config);
      if (!config.success)
        throw new Error('Sibling discount configuration is unsupported');
      siblingRule = {
        secondBps: config.data.second_bps,
        thirdPlusBps: config.data.third_plus_bps,
      };
      const householdId = rows[0]?.household_id;
      if (!householdId)
        throw new Error('Sibling discount household is missing');
      const currentPeople = [...new Set(rows.map((row) => row.person_id))];
      await sql`LOCK TABLE registrations IN SHARE MODE`.execute(trx);
      const prior = await sql<{
        id: string;
        person_id: string;
        season_id: string;
        base_price_cents: number | null;
      }>`
        SELECT r.id, r.person_id, p.season_id,
          il.amount_cents AS base_price_cents
        FROM registrations r JOIN programs p
          ON p.org_id = r.org_id AND p.id = r.program_id
        LEFT JOIN invoice_lines il
          ON il.org_id = r.org_id AND il.id = r.invoice_line_id
            AND il.kind = 'registration'
        WHERE r.org_id = ${checkout.orgId}::uuid
          AND r.household_id = ${householdId}::uuid
          AND r.status = 'confirmed'
          AND p.season_id = ANY(${sql`ARRAY[${sql.join(seasonIds.map((id) => sql`${id}::uuid`))}]`})
        FOR UPDATE OF r
      `.execute(trx);
      if (
        prior.rows.some(
          (item) =>
            currentPeople.includes(item.person_id) ||
            item.base_price_cents === null ||
            !Number.isSafeInteger(item.base_price_cents) ||
            item.base_price_cents < 0,
        ) ||
        new Set(prior.rows.map((item) => `${item.person_id}:${item.season_id}`))
          .size !== prior.rows.length
      )
        throw new Error(
          'Existing sibling registrations need a supported source loader',
        );
      existingConfirmed = prior.rows.map((item) => ({
        id: item.id,
        seasonId: item.season_id,
        basePriceCents: item.base_price_cents ?? 0,
      }));
    }
    const aid = await trx
      .selectFrom('aid_applications as a')
      .innerJoin('financial_aid_programs as p', (join) =>
        join
          .onRef('p.org_id', '=', 'a.org_id')
          .onRef('p.id', '=', 'a.financial_aid_program_id'),
      )
      .select('a.id')
      .where('a.org_id', '=', checkout.orgId)
      .where('a.household_id', 'in', [
        ...new Set(rows.map((row) => row.household_id)),
      ])
      .where('a.status', 'in', ['awarded', 'partially_awarded'])
      .where('p.season_id', 'in', seasonIds)
      .forUpdate()
      .execute();
    if (aid.length)
      throw new Error('Financial aid needs a supported source loader');
    const tax = await trx
      .selectFrom('tax_rates')
      .select('id')
      .where('org_id', '=', checkout.orgId)
      .where('active', '=', true)
      .forUpdate()
      .execute();
    if (tax.length)
      throw new Error('Active tax needs a supported source loader');
    if (
      rows.some(
        (row) => !Number.isSafeInteger(row.price_cents) || row.price_cents < 0,
      ) ||
      !Number.isSafeInteger(organization.application_fee_fixed_cents)
    )
      throw new Error('Pricing source cents exceed the safe integer range');
    const codeTexts = (cart.discountCodes ?? []).map((code) => code.trim());
    if (
      new Set(codeTexts.map((code) => code.toLocaleLowerCase('en-US'))).size !==
      codeTexts.length
    )
      throw new Error('Duplicate discount code');
    const codes = [];
    for (const code of [...codeTexts].sort((left, right) =>
      left.toLowerCase() < right.toLowerCase() ? -1 : 1,
    )) {
      codes.push(
        await reserveDiscountCode(trx, {
          orgId: checkout.orgId,
          checkoutId: checkout.checkoutId,
          accountId: checkout.accountId,
          code,
          offerings: rows.map((row) => ({
            offeringId: row.id,
            programId: row.program_id,
          })),
          now,
        }),
      );
    }
    const nowLocal = new Intl.DateTimeFormat('sv-SE', {
      timeZone: organization.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .format(now)
      .replace(' ', 'T');
    const applicationRate = {
      bps: organization.application_fee_bps,
      fixedCents: organization.application_fee_fixed_cents,
    };
    const configuredFee = settings.data.serviceFee ?? {
      enabled: false as const,
    };
    const frozenFee =
      configuredFee.enabled && configuredFee.mode === 'custom'
        ? {
            enabled: true as const,
            mode: 'custom' as const,
            custom: {
              bps: configuredFee.custom_bps,
              fixedCents: configuredFee.custom_fixed_cents,
            },
          }
        : configuredFee;
    const paymentTerms = frozenPaymentTermsSchema.parse({
      applicationRate,
      serviceFee: frozenFee,
    });
    const serviceFee: ServiceFeeConfig = !frozenFee.enabled
      ? { enabled: false }
      : frozenFee.mode === 'custom'
        ? { enabled: true, mode: 'custom', custom: frozenFee.custom }
        : {
            enabled: true,
            mode: 'cover_costs',
            application: applicationRate,
            processing: { bps: 290, fixedCents: 30 },
          };
    return {
      pricing: {
        nowLocal,
        participants: rows.map((row, index) => ({
          id: cart.offerings[index]?.lineId ?? '',
          participantId: row.person_id,
          seasonId: row.season_id,
          offeringId: row.id,
          priceCents: row.price_cents,
        })),
        addOns: [],
        existingConfirmed,
        siblingRule,
        automaticRules: [],
        codes,
        aid: [],
        applyCreditCents: 0,
        serviceFee,
        productTaxBps: 0,
      },
      paymentTerms,
    };
  }
}
