import { createHash } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import {
  registrationCartSchema,
  RegistrationCheckoutError,
} from './checkout-start.js';

export const REQUIREMENTS_VERSION = 1;

export const checkoutRequirementsSchema = z.strictObject({
  version: z.literal(REQUIREMENTS_VERSION),
  lines: z.array(
    z.strictObject({
      lineId: z.uuid(),
      addOns: z
        .array(
          z.strictObject({
            key: z.string().min(1).max(80),
            quantity: z.number().int().min(1).max(10),
            size: z.string().max(40).optional(),
          }),
        )
        .max(20),
      volunteer: z.enum(['commit', 'buyout', 'none']),
    }),
  ),
  forms: z.array(
    z.strictObject({
      lineId: z.uuid(),
      formDefinitionId: z.uuid(),
      definitionVersion: z.number().int().positive(),
      answers: z.record(z.string(), z.unknown()),
      reuseResponseId: z.uuid().optional(),
    }),
  ),
  waivers: z.array(
    z.strictObject({
      lineId: z.uuid(),
      waiverDocumentId: z.uuid(),
      documentVersion: z.number().int().positive(),
      documentHash: z.string().regex(/^[0-9a-f]{64}$/),
      signerName: z.string().trim().min(1).max(200),
      method: z.enum(['online_typed', 'online_drawn']),
    }),
  ),
  discountCodes: z.array(z.string().trim().min(1).max(80)).max(4),
  applyCreditCents: z.number().int().nonnegative(),
  planTemplateId: z.uuid().nullable(),
  chargeOnApprovalMethodId: z.uuid().nullable(),
  evidence: z
    .strictObject({
      ip: z.string().max(64).optional(),
      userAgent: z.string().max(400).optional(),
      submittedAt: z.string().optional(),
    })
    .optional(),
});

export type CheckoutRequirements = z.output<typeof checkoutRequirementsSchema>;

const formFieldSchema = z.looseObject({
  key: z.string(),
  label: z.string().optional(),
  required: z.boolean().optional(),
  type: z.string().optional(),
  options: z.array(z.string()).optional(),
});

const formDefShape = z.looseObject({
  fields: z.array(formFieldSchema).optional(),
});

export const addOnDefinitionSchema = z.strictObject({
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  priceCents: z.number().int().nonnegative(),
  taxable: z.boolean().optional(),
  required: z.boolean().optional(),
  sizes: z.array(z.string().min(1).max(40)).max(60).optional(),
  maxQuantity: z.number().int().min(1).max(10).optional(),
  description: z.string().max(500).optional(),
});
export const addOnListSchema = z.array(addOnDefinitionSchema).max(50);

export const volunteerRequirementSchema = z.strictObject({
  required: z.boolean(),
  buyoutCents: z.number().int().nonnegative(),
  description: z.string().max(500).optional(),
});

export const requirementsDiscoverySchema = z.strictObject({
  checkoutId: z.uuid(),
  status: z.string(),
  lines: z.array(
    z.strictObject({
      lineId: z.uuid(),
      offeringId: z.uuid(),
      offeringName: z.string(),
      personId: z.uuid(),
      personName: z.string(),
      requiresApproval: z.boolean(),
      forms: z.array(
        z.strictObject({
          formDefinitionId: z.uuid(),
          name: z.string(),
          version: z.number().int().positive(),
          fields: z.array(formFieldSchema),
          reusableAnswers: z.record(z.string(), z.unknown()).nullable(),
        }),
      ),
      waivers: z.array(
        z.strictObject({
          waiverDocumentId: z.uuid(),
          name: z.string(),
          version: z.number().int().positive(),
          documentHash: z.string(),
          requires: z.string(),
          bodyHtml: z.string(),
        }),
      ),
      addOns: addOnListSchema,
      volunteerRequirement: volunteerRequirementSchema.nullable(),
    }),
  ),
  creditAvailableCents: z.number().int().nonnegative(),
  installmentTemplates: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      deposit: z.unknown(),
      schedule: z.unknown(),
      minAmountCents: z.number().int().nonnegative(),
      autopayRequired: z.boolean(),
      allowedMethods: z.array(z.string()),
    }),
  ),
  requirementsSubmitted: z.boolean(),
});

export function waiverDocumentHash(bodyHtml: string, version: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ bodyHtml, version }))
    .digest('hex');
}

interface CheckoutRow {
  account_id: string;
  status: string;
  expires_at: Date;
  items: Json;
  requirements: Json;
  requirements_completed_at: Date | null;
}

async function loadCheckout(
  trx: OrgTransaction,
  orgId: string,
  checkoutId: string,
  accountId: string,
): Promise<CheckoutRow> {
  const checkout = await trx
    .selectFrom('checkouts')
    .select([
      'account_id',
      'status',
      'expires_at',
      'items',
      'requirements',
      'requirements_completed_at',
    ])
    .where('org_id', '=', orgId)
    .where('id', '=', checkoutId)
    .executeTakeFirst();
  if (!checkout || checkout.account_id !== accountId)
    throw new RegistrationCheckoutError(
      404,
      'NOT_FOUND',
      'Checkout is unavailable',
    );
  return checkout;
}

/** Form and waiver capture, add-on and volunteer choices for one family checkout. */
export class PostgresRegistrationRequirements {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    private readonly database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async discover(input: {
    orgId: string;
    checkoutId: string;
  }): Promise<z.output<typeof requirementsDiscoverySchema>> {
    if (input.orgId !== this.context.orgId)
      throw new RegistrationCheckoutError(
        403,
        'FORBIDDEN',
        'Organization mismatch',
      );
    return this.withOrg(this.context, async (trx) => {
      const checkout = await loadCheckout(
        trx,
        input.orgId,
        input.checkoutId,
        this.context.actor.accountId,
      );
      const cart = registrationCartSchema.parse(checkout.items);
      const lines: z.output<typeof requirementsDiscoverySchema>['lines'] = [];
      for (const item of cart.offerings) {
        const offering = await trx
          .selectFrom('registration_offerings')
          .select([
            'id',
            'name',
            'program_id',
            'form_definition_ids',
            'waiver_document_ids',
            'add_ons',
            'requires_approval',
          ])
          .where('org_id', '=', input.orgId)
          .where('id', '=', item.offeringId)
          .executeTakeFirstOrThrow();
        const program = await trx
          .selectFrom('programs')
          .select(['settings'])
          .where('org_id', '=', input.orgId)
          .where('id', '=', offering.program_id)
          .executeTakeFirstOrThrow();
        const person = await trx
          .selectFrom('people')
          .select(['first_name', 'last_name'])
          .where('org_id', '=', input.orgId)
          .where('id', '=', item.personId)
          .executeTakeFirstOrThrow();
        const addOns = addOnListSchema.parse(
          Array.isArray(offering.add_ons) ? offering.add_ons : [],
        );
        const volunteer = z
          .looseObject({
            volunteerRequirement: volunteerRequirementSchema.optional(),
          })
          .safeParse(program.settings);
        const forms = [];
        for (const definitionId of offering.form_definition_ids) {
          const definition = await trx
            .selectFrom('form_definitions')
            .select(['id', 'name', 'version', 'schema', 'retired_at'])
            .where('org_id', '=', input.orgId)
            .where('id', '=', definitionId)
            .executeTakeFirst();
          if (!definition || definition.retired_at)
            throw new RegistrationCheckoutError(
              409,
              'REQUIREMENTS_CHANGED',
              'A required form is no longer published',
            );
          const prior = await trx
            .selectFrom('form_responses')
            .select(['answers'])
            .where('org_id', '=', input.orgId)
            .where('form_definition_id', '=', definitionId)
            .where('subject_type', '=', 'person')
            .where('subject_id', '=', item.personId)
            .orderBy('submitted_at', 'desc')
            .limit(1)
            .executeTakeFirst();
          const shape = formDefShape.parse(definition.schema ?? {});
          forms.push({
            formDefinitionId: definition.id,
            name: definition.name,
            version: definition.version,
            fields: shape.fields ?? [],
            reusableAnswers: (prior?.answers ?? null) as Record<
              string,
              unknown
            > | null,
          });
        }
        const waivers = [];
        for (const documentId of offering.waiver_document_ids) {
          const document = await trx
            .selectFrom('waiver_documents')
            .select([
              'id',
              'name',
              'version',
              'requires',
              'body_html',
              'retired_at',
              'template_unreviewed',
            ])
            .where('org_id', '=', input.orgId)
            .where('id', '=', documentId)
            .executeTakeFirst();
          if (!document || document.retired_at || document.template_unreviewed)
            throw new RegistrationCheckoutError(
              409,
              'REQUIREMENTS_CHANGED',
              'A required waiver is no longer published',
            );
          waivers.push({
            waiverDocumentId: document.id,
            name: document.name,
            version: document.version,
            documentHash: waiverDocumentHash(
              document.body_html,
              document.version,
            ),
            requires: document.requires,
            bodyHtml: document.body_html,
          });
        }
        lines.push({
          lineId: item.lineId,
          offeringId: offering.id,
          offeringName: offering.name,
          personId: item.personId,
          personName: `${person.first_name} ${person.last_name}`,
          requiresApproval: offering.requires_approval,
          forms,
          waivers,
          addOns,
          volunteerRequirement:
            volunteer.success && volunteer.data.volunteerRequirement?.required
              ? volunteer.data.volunteerRequirement
              : null,
        });
      }
      const credit = await sql<{ balance: number }>`
        SELECT coalesce(sum(CASE WHEN kind = 'issued' THEN amount_cents
          WHEN kind IN ('applied', 'expired', 'reversed')
            THEN -abs(amount_cents) ELSE 0 END), 0)::bigint AS balance
        FROM credits
        WHERE org_id = ${input.orgId}::uuid
          AND (account_id = ${this.context.actor.accountId}::uuid
            OR household_id IN (
              SELECT household_id FROM household_members
              WHERE org_id = ${input.orgId}::uuid AND removed_at IS NULL
                AND person_id IN (
                  SELECT person_id FROM person_account_links
                  WHERE org_id = ${input.orgId}::uuid
                    AND account_id = ${this.context.actor.accountId}::uuid
                    AND revoked_at IS NULL AND verified_at IS NOT NULL)))
          AND (expires_on IS NULL OR expires_on >= current_date)
      `.execute(trx);
      const templates = await trx
        .selectFrom('installment_plan_templates')
        .select([
          'id',
          'name',
          'deposit',
          'schedule',
          'min_amount_cents',
          'autopay_required',
          'allowed_methods',
        ])
        .where('org_id', '=', input.orgId)
        .where('active', '=', true)
        .orderBy('name')
        .execute();
      return requirementsDiscoverySchema.parse({
        checkoutId: input.checkoutId,
        status: checkout.status,
        lines,
        creditAvailableCents: Math.max(0, credit.rows[0]?.balance ?? 0),
        installmentTemplates: templates.map((template) => ({
          id: template.id,
          name: template.name,
          deposit: template.deposit,
          schedule: template.schedule,
          minAmountCents: template.min_amount_cents,
          autopayRequired: template.autopay_required,
          allowedMethods: template.allowed_methods,
        })),
        requirementsSubmitted: checkout.requirements_completed_at !== null,
      });
    });
  }

  async submit(input: {
    orgId: string;
    checkoutId: string;
    requirements: CheckoutRequirements;
    userAgent: string | null;
    ip: string | null;
  }): Promise<{ checkoutId: string; requirementsSubmitted: true }> {
    if (input.orgId !== this.context.orgId)
      throw new RegistrationCheckoutError(
        403,
        'FORBIDDEN',
        'Organization mismatch',
      );
    const requirements = checkoutRequirementsSchema.parse(input.requirements);
    await this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select([
          'account_id',
          'status',
          'expires_at',
          'items',
          'requirements',
        ])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .forUpdate()
        .executeTakeFirst();
      if (!checkout || checkout.account_id !== this.context.actor.accountId)
        throw new RegistrationCheckoutError(
          404,
          'NOT_FOUND',
          'Checkout is unavailable',
        );
      if (checkout.status !== 'open')
        throw new RegistrationCheckoutError(
          409,
          'CHECKOUT_FROZEN',
          'Requirements can only change before pricing is frozen',
        );
      if (checkout.expires_at <= this.now())
        throw new RegistrationCheckoutError(
          409,
          'CHECKOUT_EXPIRED',
          'Checkout has expired',
        );
      const cart = registrationCartSchema.parse(checkout.items);
      const lineIds = new Set(cart.offerings.map((item) => item.lineId));
      const submitLines = new Map(
        requirements.lines.map((line) => [line.lineId, line]),
      );
      const submitForms = new Map(
        requirements.forms.map((form) => [
          `${form.lineId}:${form.formDefinitionId}`,
          form,
        ]),
      );
      const submitWaivers = new Map(
        requirements.waivers.map((waiver) => [
          `${waiver.lineId}:${waiver.waiverDocumentId}`,
          waiver,
        ]),
      );
      if (submitLines.size !== requirements.lines.length)
        throw new RegistrationCheckoutError(
          400,
          'DUPLICATE_REQUIREMENTS_LINE',
          'Requirements lines must be distinct',
        );
      for (const item of cart.offerings) {
        const line = submitLines.get(item.lineId);
        const offering = await trx
          .selectFrom('registration_offerings')
          .select([
            'id',
            'program_id',
            'form_definition_ids',
            'waiver_document_ids',
            'add_ons',
          ])
          .where('org_id', '=', input.orgId)
          .where('id', '=', item.offeringId)
          .executeTakeFirstOrThrow();
        const program = await trx
          .selectFrom('programs')
          .select(['settings'])
          .where('org_id', '=', input.orgId)
          .where('id', '=', offering.program_id)
          .executeTakeFirstOrThrow();
        const definitions = addOnListSchema.parse(
          Array.isArray(offering.add_ons) ? offering.add_ons : [],
        );
        const byKey = new Map(
          definitions.map((definition) => [definition.key, definition]),
        );
        for (const definition of definitions.filter(
          (entry) => entry.required,
        )) {
          const chosen = line?.addOns.find(
            (selection) => selection.key === definition.key,
          );
          if (!chosen)
            throw new RegistrationCheckoutError(
              409,
              'REQUIRED_ADD_ON',
              `Add-on "${definition.name}" is required`,
            );
        }
        for (const selection of line?.addOns ?? []) {
          const definition = byKey.get(selection.key);
          if (!definition)
            throw new RegistrationCheckoutError(
              409,
              'UNKNOWN_ADD_ON',
              'Selected add-on is not offered',
            );
          if (
            definition.maxQuantity !== undefined &&
            selection.quantity > definition.maxQuantity
          )
            throw new RegistrationCheckoutError(
              409,
              'ADD_ON_QUANTITY',
              `At most ${String(definition.maxQuantity)} of "${definition.name}"`,
            );
          if (definition.sizes?.length) {
            if (!selection.size || !definition.sizes.includes(selection.size))
              throw new RegistrationCheckoutError(
                409,
                'ADD_ON_SIZE',
                `Choose a size for "${definition.name}"`,
              );
          } else if (selection.size) {
            throw new RegistrationCheckoutError(
              409,
              'ADD_ON_SIZE',
              `"${definition.name}" has no size option`,
            );
          }
        }
        const volunteer = z
          .looseObject({
            volunteerRequirement: volunteerRequirementSchema.optional(),
          })
          .safeParse(program.settings);
        if (volunteer.success && volunteer.data.volunteerRequirement?.required) {
          if (!line || !['commit', 'buyout'].includes(line.volunteer))
            throw new RegistrationCheckoutError(
              409,
              'VOLUNTEER_REQUIRED',
              'Choose the volunteer commitment or buyout',
            );
        } else if (line && line.volunteer === 'buyout') {
          throw new RegistrationCheckoutError(
            409,
            'VOLUNTEER_UNAVAILABLE',
            'This program has no volunteer buyout',
          );
        }
        for (const definitionId of offering.form_definition_ids) {
          const submission = submitForms.get(`${item.lineId}:${definitionId}`);
          if (!submission)
            throw new RegistrationCheckoutError(
              409,
              'FORM_REQUIRED',
              'A required form is missing',
            );
          const definition = await trx
            .selectFrom('form_definitions')
            .select(['version', 'schema', 'retired_at'])
            .where('org_id', '=', input.orgId)
            .where('id', '=', definitionId)
            .executeTakeFirst();
          if (!definition || definition.retired_at)
            throw new RegistrationCheckoutError(
              409,
              'REQUIREMENTS_CHANGED',
              'A required form is no longer published',
            );
          if (definition.version !== submission.definitionVersion)
            throw new RegistrationCheckoutError(
              409,
              'REQUIREMENTS_STALE',
              'A form changed during checkout; reload and resubmit',
            );
          const shape = formDefShape.parse(definition.schema ?? {});
          for (const field of shape.fields ?? []) {
            const answer = submission.answers[field.key];
            if (
              field.required &&
              (answer === undefined ||
                answer === null ||
                (typeof answer === 'string' && !answer.trim()))
            )
              throw new RegistrationCheckoutError(
                409,
                'FORM_INCOMPLETE',
                `Required field "${field.label ?? field.key}" is unanswered`,
              );
            if (
              answer !== undefined &&
              field.options?.length &&
              typeof answer === 'string' &&
              !field.options.includes(answer)
            )
              throw new RegistrationCheckoutError(
                409,
                'FORM_INCOMPLETE',
                `Answer for "${field.label ?? field.key}" is not a listed option`,
              );
          }
        }
        for (const documentId of offering.waiver_document_ids) {
          const submission = submitWaivers.get(`${item.lineId}:${documentId}`);
          if (!submission)
            throw new RegistrationCheckoutError(
              409,
              'WAIVER_REQUIRED',
              'A required waiver is missing',
            );
          const document = await trx
            .selectFrom('waiver_documents')
            .select(['version', 'body_html', 'retired_at'])
            .where('org_id', '=', input.orgId)
            .where('id', '=', documentId)
            .executeTakeFirst();
          if (!document || document.retired_at)
            throw new RegistrationCheckoutError(
              409,
              'REQUIREMENTS_CHANGED',
              'A required waiver is no longer published',
            );
          if (
            document.version !== submission.documentVersion ||
            waiverDocumentHash(document.body_html, document.version) !==
              submission.documentHash
          )
            throw new RegistrationCheckoutError(
              409,
              'REQUIREMENTS_STALE',
              'A waiver changed during checkout; reload and resubmit',
            );
        }
      }
      const unexpected = [
        ...submitLines.keys(),
        ...submitForms.keys(),
        ...submitWaivers.keys(),
      ].filter((key) => {
        const lineId = key.split(':')[0] ?? '';
        return !lineIds.has(lineId);
      });
      if (unexpected.length)
        throw new RegistrationCheckoutError(
          400,
          'REQUIREMENTS_MISMATCH',
          'Requirements reference a line outside the cart',
        );
      if (requirements.planTemplateId) {
        const template = await trx
          .selectFrom('installment_plan_templates')
          .select(['id'])
          .where('org_id', '=', input.orgId)
          .where('id', '=', requirements.planTemplateId)
          .where('active', '=', true)
          .executeTakeFirst();
        if (!template)
          throw new RegistrationCheckoutError(
            409,
            'PLAN_UNAVAILABLE',
            'Payment plan is unavailable',
          );
      }
      if (requirements.chargeOnApprovalMethodId) {
        const method = await trx
          .selectFrom('payment_methods')
          .select('id')
          .where('account_id', '=', this.context.actor.accountId)
          .where('id', '=', requirements.chargeOnApprovalMethodId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!method)
          throw new RegistrationCheckoutError(
            409,
            'METHOD_UNAVAILABLE',
            'Saved payment method is unavailable',
          );
      }
      const stored: CheckoutRequirements = {
        ...requirements,
        evidence: {
          ...(input.ip ? { ip: input.ip } : {}),
          ...(input.userAgent ? { userAgent: input.userAgent } : {}),
          submittedAt: this.now().toISOString(),
        },
      };
      await trx
        .updateTable('checkouts')
        .set({
          requirements: stored as Json,
          requirements_completed_at: this.now(),
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.checkoutId)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'checkout.requirements_submitted',
        entityType: 'checkout',
        entityId: input.checkoutId,
        changes: {
          formCount: { tier: 'internal', after: requirements.forms.length },
          waiverCount: {
            tier: 'internal',
            after: requirements.waivers.length,
          },
        },
      });
    });
    return { checkoutId: input.checkoutId, requirementsSubmitted: true };
  }
}
