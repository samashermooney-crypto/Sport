import type { ServiceFeeConfig } from '@shared/algorithms/fees';
import type {
  AidAward,
  DiscountRule,
  PricingInput,
} from '@shared/algorithms/pricing';
import { sql } from 'kysely';
import { z } from 'zod';

import type { Json } from '../../db/types.js';
import type { OrgTransaction } from '../../db/withOrg.js';
import { reserveDiscountCode } from '../checkout/discount-codes.js';
import type { CheckoutPricingSourceLoader } from '../checkout/pricing-repo.js';
import { frozenPaymentTermsSchema } from '../finance/frozen-charge-repo.js';
import { refundTermsSchema } from '../finance/refund-terms.js';

import {
  addOnListSchema,
  parseCheckoutRequirements,
  volunteerRequirementSchema,
} from './requirements.js';

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
  })
  .strict();

const orgSettingsSchema = z
  .looseObject({
    confirmOnAchProcessing: z.boolean().optional(),
    lateFeeCents: z.number().int().nonnegative().max(10_000).optional(),
    refundTerms: refundTermsSchema.optional(),
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
  .strip();

const priceWindowSchema = z.strictObject({
  startsAt: z.string(),
  endsAt: z.string(),
  priceCents: z.number().int().nonnegative(),
});
const offeringPricingSchema = z
  .looseObject({
    early: priceWindowSchema.optional(),
    late: priceWindowSchema.optional(),
    planTemplateIds: z.array(z.uuid()).max(10).optional(),
  })
  .strip();

const autoRuleConfigSchema = z.strictObject({
  kind: z.enum(['percent', 'fixed']),
  value: z.number().int().positive(),
  offeringIds: z.array(z.uuid()).optional(),
  requiresReturning: z.boolean().optional(),
});
const siblingRuleSchema = z.strictObject({
  second_bps: z.number().int().min(0).max(10_000),
  third_plus_bps: z.number().int().min(0).max(10_000),
});

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
  program_settings: Json;
  registration_opens_at: Date | null;
  registration_closes_at: Date | null;
  active: boolean;
  pricing: Json;
  add_ons: Json;
  access_ok: boolean;
  registration_ok: boolean;
}

/**
 * Full source loader for family carts: price windows, selected add-ons,
 * volunteer buyout, sibling and automatic rules, codes, aid awards, credits
 * and product tax, all locked inside the freeze transaction.
 */
export class PostgresRegistrationPricingSource implements CheckoutPricingSourceLoader {
  async load(
    trx: OrgTransaction,
    checkout: {
      orgId: string;
      checkoutId: string;
      accountId: string;
      items: Json;
      requirements?: Json;
    },
  ): Promise<{
    pricing: PricingInput;
    paymentTerms: z.output<typeof frozenPaymentTermsSchema>;
  }> {
    const cart = cartSchema.parse(checkout.items);
    const requirements = parseCheckoutRequirements(checkout.requirements);
    if (
      new Set(cart.offerings.map((item) => item.lineId)).size !==
        cart.offerings.length ||
      new Set(
        cart.offerings.map((item) => `${item.offeringId}:${item.personId}`),
      ).size !== cart.offerings.length
    )
      throw new Error('Duplicate registration cart line');
    const defaultLines = cart.offerings.map((item) => ({
      lineId: item.lineId,
      addOns: [],
      volunteer: 'none' as const,
    }));
    const lineById = new Map(
      (requirements?.lines ?? defaultLines).map((line) => [line.lineId, line]),
    );
    for (const item of cart.offerings) {
      if (!lineById.has(item.lineId))
        throw new Error('Checkout requirements are missing for a cart line');
    }
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
    const settings = orgSettingsSchema.parse(organization.settings ?? {});
    const now = new Date();
    const rows: OfferingRow[] = [];
    for (const item of cart.offerings) {
      const result = await sql<OfferingRow>`
        SELECT o.id, o.program_id, o.division_id, o.visibility,
          ${item.personId}::uuid AS person_id,
          ${item.householdId}::uuid AS household_id, o.price_cents,
          p.season_id, p.status AS program_status, p.settings AS program_settings,
          p.registration_opens_at, p.registration_closes_at, o.active,
          o.pricing, o.add_ons,
          EXISTS (
            SELECT 1 FROM household_members athlete
            JOIN households h ON h.org_id = athlete.org_id AND h.id = athlete.household_id
            JOIN people person ON person.org_id = athlete.org_id AND person.id = athlete.person_id
            WHERE athlete.org_id = o.org_id AND athlete.person_id = ${item.personId}::uuid
              AND athlete.household_id = ${item.householdId}::uuid
              AND athlete.removed_at IS NULL
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
    await sql`LOCK TABLE automatic_discount_rules, aid_applications, tax_rates, credits IN SHARE MODE`.execute(
      trx,
    );
    const rules = await trx
      .selectFrom('automatic_discount_rules')
      .select(['id', 'kind', 'config', 'season_id', 'priority', 'stackable'])
      .where('org_id', '=', checkout.orgId)
      .where('active', '=', true)
      .where((eb) =>
        eb.or([eb('season_id', 'is', null), eb('season_id', 'in', seasonIds)]),
      )
      .forUpdate()
      .execute();
    let siblingRule: PricingInput['siblingRule'];
    const automaticRules: DiscountRule[] = [];
    let existingConfirmed: PricingInput['existingConfirmed'] = [];
    for (const rule of rules) {
      if (rule.kind === 'sibling') {
        if (siblingRule)
          throw new Error('Only one sibling discount rule is supported');
        const config = siblingRuleSchema.safeParse(rule.config);
        if (!config.success)
          throw new Error('Sibling discount configuration is unsupported');
        siblingRule = {
          secondBps: config.data.second_bps,
          thirdPlusBps: config.data.third_plus_bps,
        };
        continue;
      }
      const config = autoRuleConfigSchema.safeParse(rule.config);
      if (!config.success)
        throw new Error(
          `Automatic discount "${rule.kind}" needs a supported configuration`,
        );
      if (config.data.requiresReturning) {
        const personIds = [...new Set(rows.map((row) => row.person_id))];
        const returning = await sql<{ person_id: string }>`
          SELECT DISTINCT r.person_id
          FROM registrations r
          WHERE r.org_id = ${checkout.orgId}::uuid
            AND r.person_id = ANY(${sql`ARRAY[${sql.join(personIds.map((id) => sql`${id}::uuid`))}]`})
            AND r.status IN ('confirmed', 'transferred_out')
        `.execute(trx);
        const returningSet = new Set(
          returning.rows.map((entry) => entry.person_id),
        );
        const eligibleOfferings = rows
          .filter((row) => returningSet.has(row.person_id))
          .map((row) => row.id)
          .filter(
            (id) =>
              !config.data.offeringIds || config.data.offeringIds.includes(id),
          );
        if (!eligibleOfferings.length) continue;
        const ineligibleShares = rows.some(
          (row) =>
            !returningSet.has(row.person_id) &&
            eligibleOfferings.includes(row.id),
        );
        if (ineligibleShares)
          throw new Error(
            'Returning-participant discount cannot split a shared offering',
          );
        automaticRules.push({
          id: rule.id,
          priority: rule.priority,
          stackable: rule.stackable,
          kind: config.data.kind,
          value: config.data.value,
          eligibleOfferingIds: eligibleOfferings,
        });
        continue;
      }
      automaticRules.push({
        id: rule.id,
        priority: rule.priority,
        stackable: rule.stackable,
        kind: config.data.kind,
        value: config.data.value,
        ...(config.data.offeringIds
          ? { eligibleOfferingIds: config.data.offeringIds }
          : {}),
      });
    }
    if (siblingRule) {
      const households = new Set(rows.map((row) => row.household_id));
      if (households.size !== 1)
        throw new Error('Sibling discount requires a single household cart');
      const householdId = [...households][0];
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
    const aid: AidAward[] = [];
    const aidRows = await trx
      .selectFrom('aid_applications as a')
      .innerJoin('financial_aid_programs as p', (join) =>
        join
          .onRef('p.org_id', '=', 'a.org_id')
          .onRef('p.id', '=', 'a.financial_aid_program_id'),
      )
      .select([
        'a.id',
        'a.award_cents',
        'a.award_kind',
        'a.award_bps',
        'a.program_ids',
      ])
      .where('a.org_id', '=', checkout.orgId)
      .where('a.household_id', 'in', [
        ...new Set(rows.map((row) => row.household_id)),
      ])
      .where('a.status', 'in', ['awarded', 'partially_awarded'])
      .where('p.season_id', 'in', seasonIds)
      .forUpdate()
      .execute();
    const offeringIds = new Set(rows.map((row) => row.id));
    for (const award of aidRows) {
      if (award.award_kind === 'fixed') {
        if (
          !Number.isSafeInteger(award.award_cents) ||
          award.award_cents <= 0 ||
          award.award_bps !== null
        )
          throw new Error('Fixed aid award is malformed');
        aid.push({
          id: award.id,
          kind: 'fixed',
          value: award.award_cents,
          ...(award.program_ids.length
            ? {
                eligibleOfferingIds: rows
                  .filter((row) => award.program_ids.includes(row.program_id))
                  .map((row) => row.id),
              }
            : {}),
        });
      } else if (award.award_kind === 'percent') {
        if (
          award.award_bps === null ||
          !Number.isSafeInteger(award.award_bps) ||
          award.award_bps < 1 ||
          award.award_bps > 10_000 ||
          !Number.isSafeInteger(award.award_cents) ||
          award.award_cents < 0
        )
          throw new Error('Percent aid award is malformed');
        const eligible = award.program_ids.length
          ? rows
              .filter((row) => award.program_ids.includes(row.program_id))
              .map((row) => row.id)
          : [...offeringIds];
        if (!eligible.length) continue;
        aid.push({
          id: `${award.id}:percent`,
          kind: 'percent',
          value: award.award_bps,
          eligibleOfferingIds: eligible,
        });
        if (award.award_cents > 0)
          aid.push({
            id: award.id,
            kind: 'fixed',
            value: award.award_cents,
            eligibleOfferingIds: eligible,
          });
      }
    }
    const taxRows = await trx
      .selectFrom('tax_rates')
      .select(['rate_bps'])
      .where('org_id', '=', checkout.orgId)
      .where('active', '=', true)
      .forUpdate()
      .execute();
    if (taxRows.length > 1)
      throw new Error('Multiple active tax rates need a supported loader');
    const productTaxBps = taxRows[0]?.rate_bps ?? 0;
    if (!Number.isSafeInteger(productTaxBps) || productTaxBps < 0)
      throw new Error('Tax rate is malformed');
    const credit = await sql<{ balance: number }>`
      SELECT coalesce(sum(CASE WHEN kind = 'issued' THEN amount_cents
        WHEN kind IN ('applied', 'expired', 'reversed')
          THEN -abs(amount_cents) ELSE 0 END), 0)::bigint AS balance
      FROM credits
      WHERE org_id = ${checkout.orgId}::uuid
        AND (account_id = ${checkout.accountId}::uuid
          OR household_id IN (
            SELECT household_id FROM household_members
            WHERE org_id = ${checkout.orgId}::uuid AND removed_at IS NULL
              AND person_id IN (
                SELECT person_id FROM person_account_links
                WHERE org_id = ${checkout.orgId}::uuid
                  AND account_id = ${checkout.accountId}::uuid
                  AND revoked_at IS NULL AND verified_at IS NOT NULL)))
        AND (expires_on IS NULL OR expires_on >= current_date)
    `.execute(trx);
    const creditBalance = Math.max(0, credit.rows[0]?.balance ?? 0);
    const applyCreditCents = Math.min(
      requirements?.applyCreditCents ?? 0,
      creditBalance,
    );
    if (
      !Number.isSafeInteger(applyCreditCents) ||
      applyCreditCents < 0 ||
      (requirements?.applyCreditCents ?? 0) < 0
    )
      throw new Error('Credit application is malformed');
    const codeTexts = (requirements?.discountCodes ?? []).map((code) =>
      code.trim(),
    );
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
    const addOns: NonNullable<PricingInput['addOns']>[number][] = [];
    for (const item of cart.offerings) {
      const row = rows.find((entry) => entry.id === item.offeringId);
      const line = lineById.get(item.lineId);
      if (!row || !line) throw new Error('Cart line is missing its offering');
      const definitions = addOnListSchema.parse(
        Array.isArray(row.add_ons) ? row.add_ons : [],
      );
      const byKey = new Map(definitions.map((entry) => [entry.key, entry]));
      line.addOns.forEach((selection, index) => {
        const definition = byKey.get(selection.key);
        if (!definition) throw new Error('Selected add-on is not offered');
        if (
          definition.maxQuantity !== undefined &&
          selection.quantity > definition.maxQuantity
        )
          throw new Error('Selected add-on exceeds its quantity limit');
        if (
          definition.sizes?.length &&
          !definition.sizes.includes(selection.size ?? '')
        )
          throw new Error('Selected add-on size is not offered');
        addOns.push({
          id: `add:${item.lineId}:${selection.key}:${String(index)}`,
          parentLineId: item.lineId,
          priceCents: definition.priceCents * selection.quantity,
          taxable: definition.taxable ?? false,
        });
      });
      const programSettings = z
        .looseObject({
          volunteerRequirement: volunteerRequirementSchema.optional(),
        })
        .parse(row.program_settings ?? {});
      if (line.volunteer === 'buyout') {
        const requirement = programSettings.volunteerRequirement;
        if (!requirement?.required || requirement.buyoutCents <= 0)
          throw new Error('Volunteer buyout is unavailable');
        addOns.push({
          id: `volunteer:${item.lineId}`,
          parentLineId: item.lineId,
          priceCents: requirement.buyoutCents,
          taxable: false,
        });
      }
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
    const configuredFee = settings.serviceFee ?? { enabled: false as const };
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
        participants: rows.map((row, index) => {
          const pricing = offeringPricingSchema.parse(row.pricing ?? {});
          return {
            id: cart.offerings[index]?.lineId ?? '',
            participantId: row.person_id,
            seasonId: row.season_id,
            offeringId: row.id,
            priceCents: row.price_cents,
            ...(pricing.early ? { early: pricing.early } : {}),
            ...(pricing.late ? { late: pricing.late } : {}),
          };
        }),
        addOns,
        existingConfirmed,
        ...(siblingRule ? { siblingRule } : {}),
        automaticRules,
        codes,
        aid,
        applyCreditCents,
        serviceFee,
        productTaxBps,
      },
      paymentTerms,
    };
  }
}
