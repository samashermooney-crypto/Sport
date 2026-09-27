import { createHash } from 'node:crypto';

import { serviceFee } from '@shared/algorithms/fees';
import { generateInstallments } from '@shared/algorithms/installments';
import { newId } from '@shared/ids';
import { allocate } from '@shared/money';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import { allocateOrgNumber } from '../../db/orgCounters.js';
import type { DB, Json } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import {
  decryptRestricted,
  encryptRestricted,
  type EncryptionKeys,
} from '../../lib/crypto.js';
import { appendAuditEvent } from '../audit/service.js';
import { PostgresCheckoutHoldRepository } from '../checkout/capacity-repo.js';
import { PostgresCheckoutPricingRepository } from '../checkout/pricing-repo.js';
import {
  assertPricingSnapshot,
  CheckoutPricingService,
} from '../checkout/pricing.js';
import { enqueueFinanceNotice } from '../finance/money-notices.js';
import { refundTermsSchema } from '../finance/refund-terms.js';

import {
  registrationCartSchema,
  RegistrationCheckoutError,
} from './checkout-start.js';
import { enqueueRegistrationNotice } from './notices.js';
import { refundTermsHash } from './policy-acceptance.js';
import { PostgresRegistrationPricingSource } from './registration-pricing-source.js';
import {
  addOnListSchema,
  parseCheckoutRequirements,
  type CheckoutRequirements,
  waiverDocumentHash,
} from './requirements.js';

const planChargeSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  dueOn: z.iso.date().nullable(),
  baseCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  feeCents: z.number().int().nonnegative(),
  amountCents: z.number().int().nonnegative(),
});
export const checkoutPlanSchema = z.strictObject({
  templateId: z.uuid(),
  templateVersion: z.number().int().positive(),
  charges: z.array(planChargeSchema).min(1),
});

const frozenSnapshotSchema = z.object({
  lines: z.array(
    z.object({
      id: z.string(),
      kind: z.enum([
        'participant',
        'add_on',
        'discount',
        'aid',
        'service_fee',
        'tax',
      ]),
      amountCents: z.number().int(),
      parentLineId: z.string().optional(),
      sourceId: z.string().optional(),
      taxable: z.boolean(),
    }),
  ),
  subtotalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  aidCents: z.number().int().nonnegative(),
  creditAppliedCents: z.number().int().nonnegative(),
  serviceFeeCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  invoiceTotalCents: z.number().int().nonnegative(),
  chargeNowCents: z.number().int().nonnegative(),
  paymentTerms: z.looseObject({}),
});

export const checkoutQuoteSchema = z.strictObject({
  checkoutId: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNumber: z.number().int().positive(),
  totalCents: z.number().int().nonnegative(),
  chargeNowCents: z.number().int().nonnegative(),
  serviceFeeCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  paidInFull: z.boolean(),
  pendingApproval: z.boolean(),
  plan: z
    .strictObject({
      templateId: z.uuid(),
      depositCents: z.number().int().nonnegative(),
      installments: z.array(
        z.strictObject({
          dueOn: z.iso.date(),
          amountCents: z.number().int().nonnegative(),
        }),
      ),
    })
    .nullable(),
  lines: z.array(
    z.strictObject({
      kind: z.string(),
      description: z.string(),
      amountCents: z.number().int(),
    }),
  ),
});

interface LineDescription {
  line_id: string;
  offering_id: string;
  description: string;
  program_id: string;
  division_id: string;
  person_id: string;
  household_id: string;
  requires_approval: boolean;
}

interface ExistingInvoice {
  invoice_id: string;
  number: number;
  total_cents: number;
  balance_cents: number;
  status: string;
}

const programPolicySchema = z.looseObject({
  chargeAtSubmission: z.boolean().optional(),
  approvalDecisionHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .optional(),
  paymentDueHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
});

/** Freezes one quote and atomically issues its invoice plus pending registrations. */
export class PostgresRegistrationCheckoutQuote {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    private readonly database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly encryption?: EncryptionKeys,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async quote(input: {
    orgId: string;
    checkoutId: string;
    quoteKey: string;
  }): Promise<z.output<typeof checkoutQuoteSchema>> {
    if (input.orgId !== this.context.orgId)
      throw new RegistrationCheckoutError(
        403,
        'FORBIDDEN',
        'Organization mismatch',
      );
    z.uuid().parse(input.checkoutId);
    z.uuid().parse(input.quoteKey);
    const frozen = await new CheckoutPricingService(
      new PostgresCheckoutPricingRepository(
        this.database,
        this.context,
        new PostgresRegistrationPricingSource(),
      ),
    ).freeze({
      orgId: input.orgId,
      checkoutId: input.checkoutId,
      idempotencyKey: input.quoteKey,
    });
    assertPricingSnapshot(frozen.snapshot);
    return this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select([
          'account_id',
          'status',
          'expires_at',
          'source',
          'items',
          'pricing_snapshot',
          'requirements',
          'requirements_enc',
          'requirements_completed_at',
          'payment_plan',
        ])
        .select(sql<string | null>`invoice_id`.as('invoice_id'))
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !checkout ||
        checkout.account_id !== this.context.actor.accountId ||
        checkout.status !== 'awaiting_payment' ||
        checkout.expires_at <= new Date()
      )
        throw new RegistrationCheckoutError(
          409,
          'CHECKOUT_UNAVAILABLE',
          'Checkout is unavailable',
        );
      const snapshot = frozenSnapshotSchema.parse(checkout.pricing_snapshot);
      assertPricingSnapshot({
        lines: snapshot.lines.map((line) => ({
          id: line.id,
          kind: line.kind,
          amountCents: line.amountCents,
          taxable: line.taxable,
          ...(line.parentLineId ? { parentLineId: line.parentLineId } : {}),
          ...(line.sourceId ? { sourceId: line.sourceId } : {}),
        })),
        subtotalCents: snapshot.subtotalCents,
        discountCents: snapshot.discountCents,
        aidCents: snapshot.aidCents,
        creditAppliedCents: snapshot.creditAppliedCents,
        serviceFeeCents: snapshot.serviceFeeCents,
        taxCents: snapshot.taxCents,
        invoiceTotalCents: snapshot.invoiceTotalCents,
        chargeNowCents: snapshot.chargeNowCents,
      });
      const cart = registrationCartSchema.parse(checkout.items);
      const requirements = parseCheckoutRequirements(checkout.requirements);
      if (checkout.invoice_id)
        return this.existingQuote(trx, input.checkoutId, checkout.invoice_id, {
          ...snapshot,
          creditAppliedCents: snapshot.creditAppliedCents,
        });
      const holds = await trx
        .selectFrom('capacity_holds')
        .select(['expires_at', 'released_at', 'converted_at'])
        .where('org_id', '=', input.orgId)
        .where('checkout_id', '=', input.checkoutId)
        .forUpdate()
        .execute();
      if (
        !holds.length ||
        holds.some(
          (hold) =>
            hold.released_at ||
            hold.converted_at ||
            hold.expires_at <= new Date(),
        )
      )
        throw new RegistrationCheckoutError(
          409,
          'HOLD_EXPIRED',
          'The reserved seat has expired',
        );
      const settings = await trx
        .selectFrom('organizations')
        .select('settings')
        .where('id', '=', input.orgId)
        .executeTakeFirstOrThrow();
      const orgSettings = z
        .looseObject({ refundTerms: refundTermsSchema.optional() })
        .parse(settings.settings ?? {});
      const paidNow = snapshot.chargeNowCents > 0;
      if (paidNow || orgSettings.refundTerms) {
        if (!orgSettings.refundTerms)
          throw new RegistrationCheckoutError(
            409,
            'REFUND_POLICY_REQUIRED',
            'The organization must publish refund terms before paid registration',
          );
        const acceptedHash = refundTermsHash(orgSettings.refundTerms);
        const accepted = await sql<{ exists: boolean }>`
          SELECT EXISTS (SELECT 1 FROM checkout_policy_acceptances
            WHERE org_id = ${input.orgId}::uuid
              AND checkout_id = ${input.checkoutId}::uuid
              AND account_id = ${this.context.actor.accountId}::uuid
              AND terms_hash = ${acceptedHash}) AS exists
        `.execute(trx);
        if (!accepted.rows[0]?.exists)
          throw new RegistrationCheckoutError(
            409,
            'REFUND_TERMS_UNACCEPTED',
            'Review and accept the current refund terms',
          );
      }
      const descriptions: LineDescription[] = [];
      for (const item of cart.offerings) {
        const rows = await sql<LineDescription>`
          SELECT ${item.lineId}::uuid::text AS line_id,
            o.id AS offering_id,
            person.first_name || ' ' || person.last_name || ' — ' || o.name AS description,
            o.program_id, o.division_id, person.id AS person_id,
            ${item.householdId}::uuid AS household_id,
            o.requires_approval
          FROM registration_offerings o
          JOIN people person ON person.org_id = o.org_id AND person.id = ${item.personId}::uuid
          WHERE o.org_id = ${input.orgId}::uuid AND o.id = ${item.offeringId}::uuid
            AND o.division_id IS NOT NULL AND person.status = 'active'
          FOR UPDATE OF o, person
        `.execute(trx);
        const row = rows.rows[0];
        if (!row)
          throw new RegistrationCheckoutError(
            409,
            'CHECKOUT_UNAVAILABLE',
            'Offering changed during checkout',
          );
        descriptions.push(row);
      }
      const needsRequirements = await this.linesNeedRequirements(
        trx,
        input.orgId,
        cart.offerings.map((item) => item.offeringId),
      );
      if (needsRequirements && !checkout.requirements_completed_at)
        throw new RegistrationCheckoutError(
          409,
          'REQUIREMENTS_PENDING',
          'Required forms, waivers and choices must be submitted first',
        );
      if (requirements)
        await this.verifyRequirements(trx, input.orgId, requirements);
      const byLine = new Map(descriptions.map((item) => [item.line_id, item]));
      if (byLine.size !== cart.offerings.length)
        throw new RegistrationCheckoutError(
          409,
          'CHECKOUT_UNAVAILABLE',
          'Cart lines changed',
        );
      const programIds = [
        ...new Set(descriptions.map((item) => item.program_id)),
      ];
      const programSettingsRows = await trx
        .selectFrom('programs')
        .select(['id', 'settings'])
        .where('org_id', '=', input.orgId)
        .where('id', 'in', programIds)
        .execute();
      const programPolicies = new Map(
        programSettingsRows.map((row) => [
          row.id,
          programPolicySchema.parse(row.settings ?? {}),
        ]),
      );
      const chargeAtSubmission = descriptions
        .filter((item) => item.requires_approval)
        .every(
          (item) =>
            programPolicies.get(item.program_id)?.chargeAtSubmission === true,
        );
      const hasApprovals = descriptions.some((item) => item.requires_approval);
      const approvalDecisionHours =
        [...programPolicies.values()]
          .map((policy) => policy.approvalDecisionHours)
          .filter((hours): hours is number => hours !== undefined)
          .sort((a, b) => a - b)[0] ?? 24 * 14;

      // Installment plan: split the net-of-credit product+tax amount by the
      // template, recompute per-charge fees, then rewrite the frozen snapshot so
      // the payment reader reconciles the deposit charge exactly.
      let plan: z.output<typeof checkoutPlanSchema> | null = null;
      let effectiveSnapshot = { ...snapshot };
      if (requirements?.planTemplateId) {
        const template = await trx
          .selectFrom('installment_plan_templates')
          .select([
            'id',
            'deposit',
            'schedule',
            'min_amount_cents',
            'autopay_required',
            'allowed_methods',
            'version',
          ])
          .where('org_id', '=', input.orgId)
          .where('id', '=', requirements.planTemplateId)
          .where('active', '=', true)
          .forUpdate()
          .executeTakeFirst();
        if (!template)
          throw new RegistrationCheckoutError(
            409,
            'PLAN_UNAVAILABLE',
            'Payment plan is unavailable',
          );
        if (template.autopay_required)
          throw new RegistrationCheckoutError(
            409,
            'PLAN_AUTOPAY_CONSENT_REQUIRED',
            'This plan requires a separate automatic-payment authorization',
          );
        const templateInput = z
          .strictObject({
            deposit: z.discriminatedUnion('kind', [
              z.strictObject({
                kind: z.literal('fixed'),
                amountCents: z.number().int().nonnegative(),
              }),
              z.strictObject({
                kind: z.literal('percent'),
                bps: z.number().int().min(0).max(10_000),
              }),
            ]),
            schedule: z.discriminatedUnion('kind', [
              z.strictObject({
                kind: z.literal('monthly'),
                count: z.number().int().min(1).max(36),
                dayOfMonth: z.number().int().min(1).max(31),
              }),
              z.strictObject({
                kind: z.literal('weekly'),
                count: z.number().int().min(1).max(36),
              }),
              z.strictObject({
                kind: z.literal('fixed_dates'),
                dates: z.array(z.iso.date()).min(1).max(36),
              }),
            ]),
            minAmountCents: z.number().int().nonnegative(),
          })
          .parse({
            deposit: template.deposit,
            schedule: template.schedule,
            minAmountCents: template.min_amount_cents,
          });
        const baseCents =
          snapshot.subtotalCents -
          snapshot.discountCents -
          snapshot.aidCents -
          snapshot.creditAppliedCents;
        const productWithTax = baseCents + snapshot.taxCents;
        const todayLocal = new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'UTC',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date());
        const generated = generateInstallments(
          productWithTax,
          templateInput,
          todayLocal,
        );
        if (!generated || !generated.installments.length)
          throw new RegistrationCheckoutError(
            409,
            'PLAN_UNAVAILABLE',
            'This cart cannot use a payment plan',
          );
        if (hasApprovals && !chargeAtSubmission)
          throw new RegistrationCheckoutError(
            409,
            'PLAN_REQUIRES_PAYMENT',
            'Payment plans require charge-at-submission for approval carts',
          );
        const amounts = [
          generated.depositCents,
          ...generated.installments.map((inst) => inst.amountCents),
        ];
        const baseShares = allocate(baseCents, amounts);
        const paymentTerms = z
          .looseObject({
            serviceFee: z.discriminatedUnion('enabled', [
              z.strictObject({ enabled: z.literal(false) }),
              z.discriminatedUnion('mode', [
                z.strictObject({
                  enabled: z.literal(true),
                  mode: z.literal('cover_costs'),
                  processing: z
                    .strictObject({
                      bps: z.number().int().nonnegative().max(10_000),
                      fixedCents: z.number().int().nonnegative(),
                    })
                    .optional(),
                }),
                z.strictObject({
                  enabled: z.literal(true),
                  mode: z.literal('custom'),
                  custom: z.strictObject({
                    bps: z.number().int().nonnegative().max(10_000),
                    fixedCents: z.number().int().nonnegative(),
                  }),
                }),
              ]),
            ]),
          })
          .parse(snapshot.paymentTerms);
        const feeConfig = !paymentTerms.serviceFee.enabled
          ? { enabled: false as const }
          : paymentTerms.serviceFee.mode === 'custom'
            ? {
                enabled: true as const,
                mode: 'custom' as const,
                custom: paymentTerms.serviceFee.custom,
              }
            : {
                enabled: true as const,
                mode: 'cover_costs' as const,
                application: (
                  snapshot.paymentTerms as {
                    applicationRate: { bps: number; fixedCents: number };
                  }
                ).applicationRate,
                ...(paymentTerms.serviceFee.processing
                  ? { processing: paymentTerms.serviceFee.processing }
                  : {}),
              };
        const charges = amounts.map((amount, index) => {
          const chargeBase = baseShares[index] ?? 0;
          const chargeTax = amount - chargeBase;
          const chargeFee = serviceFee(chargeBase, feeConfig);
          return {
            sequence: index,
            dueOn:
              index === 0
                ? null
                : (generated.installments[index - 1]?.dueOn ?? null),
            baseCents: chargeBase,
            taxCents: chargeTax,
            feeCents: chargeFee,
            amountCents: amount + chargeFee,
          };
        });
        plan = checkoutPlanSchema.parse({
          templateId: template.id,
          templateVersion: template.version,
          charges,
        });
        const planFeeTotal = charges.reduce(
          (total, charge) => total + charge.feeCents,
          0,
        );
        const planInvoiceTotal = charges.reduce(
          (total, charge) => total + charge.amountCents,
          0,
        );
        const feeLine = snapshot.lines.find(
          (line) => line.kind === 'service_fee',
        );
        const lines = feeLine
          ? snapshot.lines.map((line) =>
              line.kind === 'service_fee'
                ? { ...line, amountCents: planFeeTotal }
                : line,
            )
          : [
              ...snapshot.lines,
              {
                id: 'service_fee',
                kind: 'service_fee' as const,
                amountCents: planFeeTotal,
                taxable: false,
              },
            ];
        effectiveSnapshot = {
          ...snapshot,
          lines,
          serviceFeeCents: planFeeTotal,
          invoiceTotalCents: planInvoiceTotal,
          chargeNowCents: charges[0]?.amountCents ?? 0,
          paymentTerms: {
            ...snapshot.paymentTerms,
            plan,
          },
        };
        if (charges[0] && charges[0].amountCents <= 0)
          throw new RegistrationCheckoutError(
            409,
            'PLAN_UNAVAILABLE',
            'Plan deposit is empty',
          );
      }
      const invoiceId = newId();
      const invoiceNumber = await allocateOrgNumber(
        trx,
        input.orgId,
        'invoice',
      );
      const householdIds = [
        ...new Set(cart.offerings.map((item) => item.householdId)),
      ];
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            snapshot: effectiveSnapshot,
            cart,
            terms: orgSettings.refundTerms ?? null,
            plan,
          }),
        )
        .digest('hex');
      const freeCheckout = effectiveSnapshot.chargeNowCents === 0;
      await sql`
        INSERT INTO invoices
          (id, org_id, number, account_id, household_id, status, issued_at,
           subtotal_cents, discount_cents, service_fee_cents, tax_cents,
           total_cents, credit_applied_cents, paid_cents, source, creation_key,
           creation_hash, refund_terms)
        VALUES
          (${invoiceId}::uuid, ${input.orgId}::uuid, ${invoiceNumber},
           ${this.context.actor.accountId}::uuid,
           ${householdIds.length === 1 ? householdIds[0] : null}::uuid,
           ${freeCheckout ? 'paid' : 'open'}, now(),
           ${effectiveSnapshot.subtotalCents},
           ${effectiveSnapshot.discountCents + effectiveSnapshot.aidCents},
           ${effectiveSnapshot.serviceFeeCents}, ${effectiveSnapshot.taxCents},
           ${effectiveSnapshot.invoiceTotalCents},
           ${effectiveSnapshot.creditAppliedCents},
           ${freeCheckout ? effectiveSnapshot.invoiceTotalCents : 0},
           'checkout', ${input.checkoutId}::uuid,
           ${hash},
           ${orgSettings.refundTerms ? JSON.stringify(orgSettings.refundTerms) : null}::jsonb)
      `.execute(trx);
      // Persist the applied credit rows so the ledger shows the invoice and the
      // credit balance drops exactly once, inside this same transaction.
      if (effectiveSnapshot.creditAppliedCents > 0) {
        let remaining = effectiveSnapshot.creditAppliedCents;
        const available = await sql<{ id: string; remaining: number }>`
          SELECT c.id, c.amount_cents AS remaining FROM credits c
          WHERE c.org_id = ${input.orgId}::uuid AND c.kind = 'issued'
            AND (c.account_id = ${this.context.actor.accountId}::uuid
              OR c.household_id IN (
                SELECT household_id FROM household_members
                WHERE org_id = ${input.orgId}::uuid AND removed_at IS NULL
                  AND person_id IN (
                    SELECT person_id FROM person_account_links
                    WHERE org_id = ${input.orgId}::uuid
                      AND account_id = ${this.context.actor.accountId}::uuid
                      AND revoked_at IS NULL AND verified_at IS NOT NULL)))
            AND (c.expires_on IS NULL OR c.expires_on >= current_date)
          ORDER BY c.expires_on NULLS LAST, c.created_at, c.id
          FOR UPDATE
        `.execute(trx);
        for (const source of available.rows) {
          if (remaining <= 0) break;
          const used = Math.min(remaining, source.remaining);
          await sql`
            INSERT INTO credits
              (id, org_id, account_id, household_id, amount_cents, kind,
               source, invoice_id, created_by)
            SELECT ${newId()}::uuid, ${input.orgId}::uuid, c.account_id,
              c.household_id, ${used}, 'applied', c.source,
              ${invoiceId}::uuid, ${this.context.actor.accountId}::uuid
            FROM credits c WHERE c.org_id = ${input.orgId}::uuid
              AND c.id = ${source.id}::uuid
          `.execute(trx);
          remaining -= used;
        }
        if (remaining > 0)
          throw new RegistrationCheckoutError(
            409,
            'CREDIT_UNAVAILABLE',
            'Available credit changed during checkout',
          );
      }
      const lineIds = new Map(
        effectiveSnapshot.lines.map((line) => [line.id, newId()]),
      );
      const outputLines: z.output<typeof checkoutQuoteSchema>['lines'] = [];
      for (const [index, line] of effectiveSnapshot.lines.entries()) {
        const lineId = lineIds.get(line.id);
        if (!lineId) throw new Error('Invoice line ID missing');
        const description =
          line.kind === 'participant'
            ? byLine.get(line.id)?.description
            : line.kind === 'service_fee'
              ? 'Service fee'
              : line.kind === 'discount'
                ? 'Registration discount'
                : line.kind === 'aid'
                  ? 'Financial aid'
                  : line.kind === 'tax'
                    ? 'Sales tax'
                    : line.id.startsWith('volunteer:')
                      ? 'Volunteer buyout'
                      : 'Registration add-on';
        if (
          !description ||
          (line.kind === 'participant' && !byLine.has(line.id))
        )
          throw new RegistrationCheckoutError(
            409,
            'CHECKOUT_UNAVAILABLE',
            'Price line has no participant',
          );
        await sql`
          INSERT INTO invoice_lines
            (id, org_id, invoice_id, kind, description, quantity,
             unit_amount_cents, amount_cents, refundable, parent_line_id,
             checkout_line_index)
          VALUES
            (${lineId}::uuid, ${input.orgId}::uuid, ${invoiceId}::uuid,
             ${line.kind === 'participant' ? 'registration' : line.kind},
             ${description}, 1, ${line.amountCents}, ${line.amountCents},
             ${line.kind !== 'discount' && line.kind !== 'aid'},
             ${line.parentLineId ? (lineIds.get(line.parentLineId) ?? null) : null}::uuid,
             ${index})
        `.execute(trx);
        outputLines.push({
          kind: line.kind,
          description,
          amountCents: line.amountCents,
        });
      }
      const registrationIds = new Map<string, string>();
      const registrationStatus = hasApprovals
        ? 'pending_approval'
        : 'pending_payment';
      for (const [index, item] of cart.offerings.entries()) {
        const detail = descriptions[index];
        const invoiceLineId = lineIds.get(item.lineId);
        if (!detail || !invoiceLineId)
          throw new Error('Registration invoice line is missing');
        const registrationId = newId();
        registrationIds.set(item.lineId, registrationId);
        await trx
          .insertInto('registrations')
          .values({
            id: registrationId,
            org_id: input.orgId,
            program_id: detail.program_id,
            division_id: detail.division_id,
            offering_id: detail.offering_id,
            person_id: detail.person_id,
            household_id: detail.household_id,
            registered_by_account_id: this.context.actor.accountId,
            source:
              checkout.source === 'waitlist_offer'
                ? 'offer_acceptance'
                : 'online',
            status: registrationStatus,
            checkout_id: input.checkoutId,
            invoice_line_id: invoiceLineId,
            ...(hasApprovals && !chargeAtSubmission
              ? { approval_payment_due_at: null }
              : {}),
          })
          .execute();
        await trx
          .updateTable('invoice_lines')
          .set({ registration_id: registrationId })
          .where('org_id', '=', input.orgId)
          .where('id', '=', invoiceLineId)
          .execute();
        await trx
          .insertInto('registration_status_history')
          .values({
            id: newId(),
            org_id: input.orgId,
            registration_id: registrationId,
            from_status: null,
            to_status: registrationStatus,
            actor_account_id: this.context.actor.accountId,
          })
          .execute();
        await trx
          .updateTable('team_entry_invites')
          .set({ accepted_registration_id: registrationId })
          .where('org_id', '=', input.orgId)
          .where('checkout_id', '=', input.checkoutId)
          .where('person_id', '=', item.personId)
          .where('status', '=', 'accepted')
          .where('accepted_registration_id', 'is', null)
          .execute();
      }
      // Persist the frozen requirement evidence: versioned form answers,
      // waiver signatures bound to the exact document hash, and add-on/size
      // selections for the uniform report.
      if (requirements) {
        const restrictedAnswers = checkout.requirements_enc
          ? z
              .strictObject({
                version: z.literal(1),
                forms: z.record(z.string(), z.record(z.string(), z.unknown())),
              })
              .parse(
                JSON.parse(
                  decryptRestricted(
                    checkout.requirements_enc,
                    this.requireEncryption(),
                  ).toString('utf8'),
                ),
              )
          : { version: 1 as const, forms: {} };
        for (const form of requirements.forms) {
          const registrationId = registrationIds.get(form.lineId);
          if (!registrationId)
            throw new Error('Form submission references a missing line');
          const prior = form.reuseResponseId
            ? await trx
                .selectFrom('form_responses')
                .select(['id'])
                .where('org_id', '=', input.orgId)
                .where('id', '=', form.reuseResponseId)
                .executeTakeFirst()
            : undefined;
          const restricted =
            restrictedAnswers.forms[`${form.lineId}:${form.formDefinitionId}`];
          await trx
            .insertInto('form_responses')
            .values({
              id: newId(),
              org_id: input.orgId,
              form_definition_id: form.formDefinitionId,
              definition_version: form.definitionVersion,
              subject_type: 'registration',
              subject_id: registrationId,
              answers: form.answers as Json,
              answers_enc: restricted
                ? encryptRestricted(
                    Buffer.from(JSON.stringify(restricted)),
                    this.requireEncryption(),
                  )
                : null,
              submitted_by_account_id: this.context.actor.accountId,
              supersedes_id: prior?.id ?? null,
            })
            .execute();
          const personId = descriptions.find(
            (item) => item.line_id === form.lineId,
          )?.person_id;
          if (personId) {
            await trx
              .insertInto('form_responses')
              .values({
                id: newId(),
                org_id: input.orgId,
                form_definition_id: form.formDefinitionId,
                definition_version: form.definitionVersion,
                subject_type: 'person',
                subject_id: personId,
                answers: form.answers as Json,
                answers_enc: restricted
                  ? encryptRestricted(
                      Buffer.from(JSON.stringify(restricted)),
                      this.requireEncryption(),
                    )
                  : null,
                submitted_by_account_id: this.context.actor.accountId,
                supersedes_id: prior?.id ?? null,
              })
              .execute();
          }
        }
        for (const waiver of requirements.waivers) {
          const registrationId = registrationIds.get(waiver.lineId);
          if (!registrationId)
            throw new Error('Waiver signature references a missing line');
          const personId = descriptions.find(
            (item) => item.line_id === waiver.lineId,
          )?.person_id;
          if (!personId || !waiver.signerRole)
            throw new RegistrationCheckoutError(
              409,
              'WAIVER_SIGNER_REQUIRED',
              'Waiver signer evidence is incomplete',
            );
          const signatures = waiver.participantSignerName
            ? [
                { name: waiver.signerName, signerPersonId: null },
                {
                  name: waiver.participantSignerName,
                  signerPersonId: personId,
                },
              ]
            : [
                {
                  name: waiver.signerName,
                  signerPersonId:
                    waiver.signerRole === 'participant' ? personId : null,
                },
              ];
          for (const signature of signatures) {
            await sql`
              INSERT INTO waiver_signatures
                (id, org_id, waiver_document_id, document_version, document_hash,
                 participant_person_id, signer_account_id, signer_person_id,
                 signer_name_typed, method, registration_id, ip, user_agent)
              VALUES
                (${newId()}::uuid, ${input.orgId}::uuid,
                 ${waiver.waiverDocumentId}::uuid, ${waiver.documentVersion},
                 decode(${waiver.documentHash}, 'hex'), ${personId}::uuid,
                 ${this.context.actor.accountId}::uuid,
                 ${signature.signerPersonId}::uuid, ${signature.name},
                 ${waiver.method}, ${registrationId}::uuid,
                 ${requirements.evidence?.ip ?? null}::inet,
                 ${requirements.evidence?.userAgent ?? null})
            `.execute(trx);
          }
        }
        for (const line of requirements.lines) {
          const registrationId = registrationIds.get(line.lineId);
          if (!registrationId)
            throw new Error('Add-on selection references a missing line');
          for (const [index, selection] of line.addOns.entries()) {
            const priceLineId = `add:${line.lineId}:${selection.key}:${String(index)}`;
            const invoiceLineId = lineIds.get(priceLineId);
            const offering = descriptions.find(
              (item) => item.line_id === line.lineId,
            );
            const price = await this.addOnPrice(
              trx,
              input.orgId,
              offering?.offering_id ?? '',
              selection.key,
            );
            await trx
              .insertInto('registration_add_on_selections')
              .values({
                id: newId(),
                org_id: input.orgId,
                registration_id: registrationId,
                invoice_line_id: invoiceLineId ?? null,
                line_key: selection.key,
                name: price.name,
                size: selection.size ?? null,
                quantity: selection.quantity,
                unit_amount_cents: price.unitCents,
                amount_cents: price.unitCents * selection.quantity,
              })
              .execute();
          }
          if (line.volunteer === 'buyout') {
            const invoiceLineId = lineIds.get(`volunteer:${line.lineId}`);
            const buyout = z
              .looseObject({
                volunteerRequirement: z
                  .strictObject({
                    buyoutCents: z.number().int().nonnegative(),
                  })
                  .optional(),
              })
              .parse(
                programSettingsRows.find(
                  (row) =>
                    row.id ===
                    descriptions.find((item) => item.line_id === line.lineId)
                      ?.program_id,
                )?.settings ?? {},
              ).volunteerRequirement;
            if (buyout)
              await trx
                .insertInto('registration_add_on_selections')
                .values({
                  id: newId(),
                  org_id: input.orgId,
                  registration_id: registrationId,
                  invoice_line_id: invoiceLineId ?? null,
                  line_key: 'volunteer_buyout',
                  name: 'Volunteer buyout',
                  size: null,
                  quantity: 1,
                  unit_amount_cents: buyout.buyoutCents,
                  amount_cents: buyout.buyoutCents,
                })
                .execute();
          }
        }
        if (plan) {
          await trx
            .updateTable('checkouts')
            .set({ payment_plan: plan as Json })
            .where('org_id', '=', input.orgId)
            .where('id', '=', input.checkoutId)
            .execute();
          for (const charge of plan.charges.slice(1)) {
            if (!charge.dueOn) throw new Error('Installment date is missing');
            await trx
              .insertInto('installments')
              .values({
                id: newId(),
                org_id: input.orgId,
                invoice_id: invoiceId,
                sequence: charge.sequence,
                due_on: charge.dueOn,
                amount_cents: charge.amountCents,
                autopay: false,
              })
              .execute();
          }
        }
      }
      // Approval-required carts: extend the hold to the staff decision window
      // unless the org charges at submission (in which case a normal payment
      // follows and approval gates confirmation).
      if (hasApprovals && !chargeAtSubmission) {
        const decisionDeadline = new Date(
          this.now().getTime() + approvalDecisionHours * 3_600_000,
        );
        await trx
          .updateTable('capacity_holds')
          .set({ expires_at: decisionDeadline })
          .where('org_id', '=', input.orgId)
          .where('checkout_id', '=', input.checkoutId)
          .where('released_at', 'is', null)
          .where('converted_at', 'is', null)
          .execute();
        await trx
          .updateTable('checkouts')
          .set({
            expires_at: decisionDeadline,
            version: sql`version + 1`,
          })
          .where('org_id', '=', input.orgId)
          .where('id', '=', input.checkoutId)
          .execute();
      }
      if (plan) {
        await trx
          .updateTable('checkouts')
          .set({
            pricing_snapshot: {
              ...effectiveSnapshot,
              sourceVersion: 1,
            } as Json,
            version: sql`version + 1`,
          })
          .where('org_id', '=', input.orgId)
          .where('id', '=', input.checkoutId)
          .execute();
      }
      await sql`UPDATE checkouts SET invoice_id = ${invoiceId}::uuid, version = version + 1
        WHERE org_id = ${input.orgId}::uuid AND id = ${input.checkoutId}::uuid`.execute(
        trx,
      );
      await appendAuditEvent(trx, this.context, {
        action: 'checkout.invoice_issued',
        entityType: 'checkout',
        entityId: input.checkoutId,
        changes: {
          invoiceId: { tier: 'internal', after: invoiceId },
          totalCents: {
            tier: 'internal',
            after: effectiveSnapshot.invoiceTotalCents,
          },
          pendingApproval: { tier: 'internal', after: hasApprovals },
          plan: { tier: 'internal', after: plan !== null },
        },
      });
      if (!freeCheckout && !hasApprovals)
        await enqueueFinanceNotice(trx, this.context, {
          kind: 'invoice_issued',
          sourceId: invoiceId,
          accountId: this.context.actor.accountId,
        });
      if (hasApprovals)
        await enqueueRegistrationNotice(trx, this.context, {
          kind: 'registration_pending_approval',
          sourceId: invoiceId,
          accountId: this.context.actor.accountId,
          payload: { checkoutId: input.checkoutId },
        });
      // A zero-balance checkout confirms immediately without Stripe.
      if (freeCheckout && !hasApprovals) {
        const confirmed = await new PostgresCheckoutHoldRepository(
          this.database,
          this.context,
        ).confirmInTransaction(trx, {
          orgId: input.orgId,
          checkoutId: input.checkoutId,
          honorProcessingHold: true,
        });
        if (confirmed !== 'confirmed' && confirmed !== 'already_confirmed')
          throw new RegistrationCheckoutError(
            409,
            'CHECKOUT_UNAVAILABLE',
            'Free checkout could not be confirmed',
          );
        await enqueueRegistrationNotice(trx, this.context, {
          kind: 'registration_confirmed',
          sourceId: invoiceId,
          accountId: this.context.actor.accountId,
          payload: { checkoutId: input.checkoutId },
        });
      }
      return checkoutQuoteSchema.parse({
        checkoutId: input.checkoutId,
        invoiceId,
        invoiceNumber,
        totalCents: effectiveSnapshot.invoiceTotalCents,
        chargeNowCents: effectiveSnapshot.chargeNowCents,
        serviceFeeCents: effectiveSnapshot.serviceFeeCents,
        taxCents: effectiveSnapshot.taxCents,
        paidInFull: freeCheckout,
        pendingApproval: hasApprovals && !chargeAtSubmission,
        plan: plan
          ? {
              templateId: plan.templateId,
              depositCents: plan.charges[0]?.amountCents ?? 0,
              installments: plan.charges.slice(1).map((charge) => ({
                dueOn: charge.dueOn ?? '',
                amountCents: charge.amountCents,
              })),
            }
          : null,
        lines: outputLines,
      });
    });
  }

  private async linesNeedRequirements(
    trx: OrgTransaction,
    orgId: string,
    offeringIds: string[],
  ): Promise<boolean> {
    const row = await sql<{ needed: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM registration_offerings o
        WHERE o.org_id = ${orgId}::uuid AND o.id = ANY(${sql`ARRAY[${sql.join(offeringIds.map((id) => sql`${id}::uuid`))}]`})
          AND (cardinality(o.form_definition_ids) > 0
            OR cardinality(o.waiver_document_ids) > 0
            OR jsonb_array_length(o.add_ons) > 0
            OR o.requires_approval)
      ) OR EXISTS (
        SELECT 1 FROM registration_offerings o
        JOIN programs p ON p.org_id = o.org_id AND p.id = o.program_id
        WHERE o.org_id = ${orgId}::uuid AND o.id = ANY(${sql`ARRAY[${sql.join(offeringIds.map((id) => sql`${id}::uuid`))}]`})
          AND coalesce((p.settings -> 'volunteerRequirement' ->> 'required')::boolean, false)
      ) AS needed
    `.execute(trx);
    return Boolean(row.rows[0]?.needed);
  }

  /** Re-verify every submitted form/waiver version and hash at quote time. */
  private async verifyRequirements(
    trx: OrgTransaction,
    orgId: string,
    requirements: CheckoutRequirements,
  ): Promise<void> {
    for (const form of requirements.forms) {
      const definition = await trx
        .selectFrom('form_definitions')
        .select(['version', 'retired_at'])
        .where('org_id', '=', orgId)
        .where('id', '=', form.formDefinitionId)
        .executeTakeFirst();
      if (
        !definition ||
        definition.retired_at ||
        definition.version !== form.definitionVersion
      )
        throw new RegistrationCheckoutError(
          409,
          'REQUIREMENTS_STALE',
          'A form changed during checkout; reload and resubmit',
        );
    }
    for (const waiver of requirements.waivers) {
      const document = await trx
        .selectFrom('waiver_documents')
        .select(['version', 'body_html', 'retired_at'])
        .where('org_id', '=', orgId)
        .where('id', '=', waiver.waiverDocumentId)
        .executeTakeFirst();
      if (
        !document ||
        document.retired_at ||
        document.version !== waiver.documentVersion ||
        waiverDocumentHash(document.body_html) !== waiver.documentHash
      )
        throw new RegistrationCheckoutError(
          409,
          'REQUIREMENTS_STALE',
          'A waiver changed during checkout; reload and resubmit',
        );
    }
  }

  private async addOnPrice(
    trx: OrgTransaction,
    orgId: string,
    offeringId: string,
    key: string,
  ): Promise<{ name: string; unitCents: number }> {
    const offering = await trx
      .selectFrom('registration_offerings')
      .select(['add_ons'])
      .where('org_id', '=', orgId)
      .where('id', '=', offeringId)
      .executeTakeFirstOrThrow();
    const definitions = addOnListSchema.parse(
      Array.isArray(offering.add_ons) ? offering.add_ons : [],
    );
    const found = definitions.find((entry) => entry.key === key);
    if (!found) throw new Error('Selected add-on is not offered');
    return { name: found.name, unitCents: found.priceCents };
  }

  private async existingQuote(
    trx: OrgTransaction,
    checkoutId: string,
    invoiceId: string,
    snapshot: z.output<typeof frozenSnapshotSchema>,
  ): Promise<z.output<typeof checkoutQuoteSchema>> {
    const invoice = await sql<ExistingInvoice>`
      SELECT id AS invoice_id, number, total_cents, balance_cents, status
      FROM invoices
      WHERE org_id = ${this.context.orgId}::uuid AND id = ${invoiceId}::uuid
    `.execute(trx);
    const row = invoice.rows[0];
    if (!row || row.total_cents !== snapshot.invoiceTotalCents)
      throw new RegistrationCheckoutError(
        409,
        'QUOTE_CHANGED',
        'Checkout invoice no longer matches its quote',
      );
    const pendingApproval = await sql<{ pending: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM registrations
        WHERE org_id = ${this.context.orgId}::uuid
          AND checkout_id = ${checkoutId}::uuid
          AND status = 'pending_approval') AS pending
    `.execute(trx);
    const plan = checkoutPlanSchema
      .nullable()
      .parse((snapshot.paymentTerms as { plan?: unknown }).plan ?? null);
    const lines = await sql<{
      kind: string;
      description: string;
      amount_cents: number;
    }>`
      SELECT kind, description, amount_cents FROM invoice_lines
      WHERE org_id = ${this.context.orgId}::uuid AND invoice_id = ${invoiceId}::uuid
      ORDER BY checkout_line_index
    `.execute(trx);
    return checkoutQuoteSchema.parse({
      checkoutId,
      invoiceId,
      invoiceNumber: row.number,
      totalCents: row.total_cents,
      chargeNowCents: row.balance_cents,
      serviceFeeCents: snapshot.serviceFeeCents,
      taxCents: snapshot.taxCents,
      paidInFull: row.status === 'paid',
      pendingApproval: pendingApproval.rows[0]?.pending ?? false,
      plan: plan
        ? {
            templateId: plan.templateId,
            depositCents: plan.charges[0]?.amountCents ?? 0,
            installments: plan.charges.slice(1).map((charge) => ({
              dueOn: charge.dueOn ?? '',
              amountCents: charge.amountCents,
            })),
          }
        : null,
      lines: lines.rows.map((line) => ({
        kind: line.kind === 'registration' ? 'participant' : line.kind,
        description: line.description,
        amountCents: line.amount_cents,
      })),
    });
  }

  private requireEncryption(): EncryptionKeys {
    if (!this.encryption)
      throw new Error(
        'Restricted registration answers require encryption keys',
      );
    return this.encryption;
  }
}
