import { createHash } from 'node:crypto';

import { ageOnDate } from '@shared/dates';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

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

import {
  registrationCartSchema,
  RegistrationCheckoutError,
} from './checkout-start.js';

const REQUIREMENTS_VERSION = 1;

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
      accepted: z.literal(true),
      signerName: z.string().trim().min(1).max(200),
      participantSignerName: z.string().trim().min(1).max(200).optional(),
      signerRole: z.enum(['guardian', 'participant']).optional(),
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

export function parseCheckoutRequirements(
  value: Json | null | undefined,
): CheckoutRequirements | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
    return null;
  return checkoutRequirementsSchema.parse(value);
}

const sensitivitySchema = z.enum([
  'public',
  'internal',
  'sensitive',
  'restricted',
]);

const formFieldSchema = z.looseObject({
  key: z.string(),
  label: z.string().optional(),
  required: z.boolean().optional(),
  type: z.string().optional(),
  options: z.array(z.string()).optional(),
  sensitivity: sensitivitySchema.optional(),
  sensitivityTier: sensitivitySchema.optional(),
  tier: sensitivitySchema.optional(),
});

const formDefShape = z.looseObject({
  fields: z.array(formFieldSchema).optional(),
});

const addOnDefinitionSchema = z.strictObject({
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

export function waiverDocumentHash(bodyHtml: string): string {
  const renderedText = bodyHtml
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(renderedText).digest('hex');
}

function orgLocalDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function sameName(left: string, right: string): boolean {
  return (
    left.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ===
    right.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  );
}

function fieldSensitivity(
  field: z.output<typeof formFieldSchema>,
): z.infer<typeof sensitivitySchema> {
  return field.sensitivity ?? field.sensitivityTier ?? field.tier ?? 'internal';
}

function splitFormAnswers(
  fields: z.output<typeof formFieldSchema>[],
  answers: Record<string, unknown>,
): { answers: Record<string, unknown>; restricted: Record<string, unknown> } {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const plain: Record<string, unknown> = {};
  const restricted: Record<string, unknown> = {};
  for (const [key, answer] of Object.entries(answers)) {
    const field = byKey.get(key);
    if (!field)
      throw new RegistrationCheckoutError(
        400,
        'FORM_FIELD_UNKNOWN',
        'A submitted form contains an unknown field',
      );
    if (fieldSensitivity(field) === 'restricted') restricted[key] = answer;
    else plain[key] = answer;
  }
  return { answers: plain, restricted };
}

function mergeFormAnswers(
  fields: z.output<typeof formFieldSchema>[],
  answers: Record<string, unknown>,
  restricted: Record<string, unknown>,
): Record<string, unknown> {
  return { ...answers, ...splitFormAnswers(fields, restricted).restricted };
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
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly encryption: EncryptionKeys,
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
            .select(['answers', 'answers_enc'])
            .where('org_id', '=', input.orgId)
            .where('form_definition_id', '=', definitionId)
            .where('subject_type', '=', 'person')
            .where('subject_id', '=', item.personId)
            .orderBy('submitted_at', 'desc')
            .limit(1)
            .executeTakeFirst();
          const shape = formDefShape.parse(definition.schema ?? {});
          const reusable = (prior?.answers ?? {}) as Record<string, unknown>;
          const reusableRestricted = prior?.answers_enc
            ? z
                .record(z.string(), z.unknown())
                .parse(
                  JSON.parse(
                    decryptRestricted(
                      prior.answers_enc,
                      this.encryption,
                    ).toString('utf8'),
                  ),
                )
            : {};
          forms.push({
            formDefinitionId: definition.id,
            name: definition.name,
            version: definition.version,
            fields: shape.fields ?? [],
            reusableAnswers: prior
              ? mergeFormAnswers(
                  shape.fields ?? [],
                  reusable,
                  reusableRestricted,
                )
              : null,
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
            documentHash: waiverDocumentHash(document.body_html),
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
    if (requirements.waivers.some((waiver) => waiver.signerRole))
      throw new RegistrationCheckoutError(
        400,
        'WAIVER_SIGNER_MISMATCH',
        'Signer role is assigned by the registration service',
      );
    await this.withOrg(this.context, async (trx) => {
      const checkout = await trx
        .selectFrom('checkouts')
        .select(['account_id', 'status', 'expires_at', 'items', 'requirements'])
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
      const signerAccount = await trx
        .selectFrom('accounts')
        .select(['first_name', 'last_name'])
        .where('id', '=', this.context.actor.accountId)
        .executeTakeFirstOrThrow();
      const organization = await trx
        .selectFrom('organizations')
        .select('timezone')
        .where('id', '=', input.orgId)
        .executeTakeFirstOrThrow();
      const localDate = orgLocalDate(this.now(), organization.timezone);
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
      if (
        submitForms.size !== requirements.forms.length ||
        submitWaivers.size !== requirements.waivers.length ||
        lineIds.size !== submitLines.size ||
        [...submitLines.keys()].some((lineId) => !lineIds.has(lineId))
      )
        throw new RegistrationCheckoutError(
          400,
          'REQUIREMENTS_MISMATCH',
          'Requirements must match every cart line exactly once',
        );
      const restrictedByForm: Record<string, Record<string, unknown>> = {};
      const sanitizedForms = new Map<
        string,
        CheckoutRequirements['forms'][number]
      >();
      const expectedFormKeys = new Set<string>();
      const expectedWaiverKeys = new Set<string>();
      const signerRoles = new Map<string, 'guardian' | 'participant'>();
      for (const item of cart.offerings) {
        const line = submitLines.get(item.lineId);
        if (!line)
          throw new RegistrationCheckoutError(
            400,
            'REQUIREMENTS_LINE_MISSING',
            'Requirements are missing a cart line',
          );
        if (
          new Set(line.addOns.map((selection) => selection.key)).size !==
          line.addOns.length
        )
          throw new RegistrationCheckoutError(
            400,
            'ADD_ON_DUPLICATE',
            'Choose each add-on once per participant',
          );
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
          const chosen = line.addOns.find(
            (selection) => selection.key === definition.key,
          );
          if (!chosen)
            throw new RegistrationCheckoutError(
              409,
              'REQUIRED_ADD_ON',
              `Add-on "${definition.name}" is required`,
            );
        }
        for (const selection of line.addOns) {
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
        if (
          volunteer.success &&
          volunteer.data.volunteerRequirement?.required
        ) {
          if (!['commit', 'buyout'].includes(line.volunteer))
            throw new RegistrationCheckoutError(
              409,
              'VOLUNTEER_REQUIRED',
              'Choose the volunteer commitment or buyout',
            );
        } else if (line.volunteer === 'buyout') {
          throw new RegistrationCheckoutError(
            409,
            'VOLUNTEER_UNAVAILABLE',
            'This program has no volunteer buyout',
          );
        }
        for (const definitionId of offering.form_definition_ids) {
          expectedFormKeys.add(`${item.lineId}:${definitionId}`);
          const submission = submitForms.get(`${item.lineId}:${definitionId}`);
          if (!submission)
            throw new RegistrationCheckoutError(
              409,
              'FORM_REQUIRED',
              'A required form is missing',
            );
          const definition = await trx
            .selectFrom('form_definitions')
            .select(['id', 'version', 'schema', 'retired_at', 'scope'])
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
          if (definition.scope !== 'registration')
            throw new RegistrationCheckoutError(
              409,
              'FORM_UNAVAILABLE',
              'The required form is not a registration form',
            );
          if (submission.reuseResponseId) {
            const reusable = await trx
              .selectFrom('form_responses')
              .select('id')
              .where('org_id', '=', input.orgId)
              .where('id', '=', submission.reuseResponseId)
              .where('form_definition_id', '=', definitionId)
              .where('subject_type', '=', 'person')
              .where('subject_id', '=', item.personId)
              .executeTakeFirst();
            if (!reusable)
              throw new RegistrationCheckoutError(
                409,
                'FORM_RESPONSE_UNAVAILABLE',
                'The selected saved response is unavailable for this participant',
              );
          }
          const { answers: plainAnswers, restricted } = splitFormAnswers(
            shape.fields ?? [],
            submission.answers,
          );
          sanitizedForms.set(`${item.lineId}:${definitionId}`, {
            ...submission,
            answers: plainAnswers,
          });
          if (Object.keys(restricted).length)
            restrictedByForm[`${item.lineId}:${definitionId}`] = restricted;
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
          expectedWaiverKeys.add(`${item.lineId}:${documentId}`);
          const document = await trx
            .selectFrom('waiver_documents')
            .select(['version', 'body_html', 'retired_at', 'requires'])
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
            waiverDocumentHash(document.body_html) !== submission.documentHash
          )
            throw new RegistrationCheckoutError(
              409,
              'REQUIREMENTS_STALE',
              'A waiver changed during checkout; reload and resubmit',
            );
          const person = await trx
            .selectFrom('people')
            .select(['date_of_birth', 'first_name', 'last_name'])
            .where('org_id', '=', input.orgId)
            .where('id', '=', item.personId)
            .executeTakeFirstOrThrow();
          const links = await trx
            .selectFrom('person_account_links')
            .select('relationship')
            .where('org_id', '=', input.orgId)
            .where('person_id', '=', item.personId)
            .where('account_id', '=', this.context.actor.accountId)
            .where('verified_at', 'is not', null)
            .where('revoked_at', 'is', null)
            .execute();
          const isGuardian = links.some(
            (link) => link.relationship === 'guardian',
          );
          const isParticipant = links.some(
            (link) => link.relationship === 'self',
          );
          const minor =
            ageOnDate(
              person.date_of_birth.toISOString().slice(0, 10),
              localDate,
            ) < 18;
          const personName = `${person.first_name} ${person.last_name}`;
          const accountName = `${signerAccount.first_name} ${signerAccount.last_name}`;
          const guardianSignatureMatches =
            isGuardian && sameName(submission.signerName, accountName);
          const participantSignatureMatches =
            isParticipant && sameName(submission.signerName, personName);
          const childSignatureMatches = sameName(
            submission.participantSignerName ?? '',
            personName,
          );
          const validSigner =
            document.requires === 'guardian_if_minor'
              ? minor
                ? guardianSignatureMatches
                : participantSignatureMatches
              : document.requires === 'participant'
                ? participantSignatureMatches
                : guardianSignatureMatches && childSignatureMatches;
          if (!validSigner)
            throw new RegistrationCheckoutError(
              409,
              'WAIVER_SIGNER_REQUIRED',
              document.requires === 'both'
                ? 'A verified guardian and the participant must sign this waiver'
                : minor
                  ? 'A verified guardian must sign this waiver'
                  : 'The participant must sign this waiver',
            );
          signerRoles.set(
            `${item.lineId}:${documentId}`,
            document.requires === 'both' ||
              (document.requires === 'guardian_if_minor' && minor)
              ? 'guardian'
              : 'participant',
          );
          if (
            document.requires !== 'both' &&
            submission.participantSignerName !== undefined
          )
            throw new RegistrationCheckoutError(
              400,
              'WAIVER_SIGNER_MISMATCH',
              'This waiver does not require a participant co-signature',
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
      if (
        [...submitForms.keys()].some((key) => !expectedFormKeys.has(key)) ||
        [...submitWaivers.keys()].some((key) => !expectedWaiverKeys.has(key))
      )
        throw new RegistrationCheckoutError(
          400,
          'REQUIREMENTS_MISMATCH',
          'Requirements include a form or waiver outside this cart',
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
        waivers: requirements.waivers.map((waiver) => ({
          ...waiver,
          signerRole: signerRoles.get(
            `${waiver.lineId}:${waiver.waiverDocumentId}`,
          ),
        })),
        forms: requirements.forms.map(
          (form) =>
            sanitizedForms.get(`${form.lineId}:${form.formDefinitionId}`) ??
            form,
        ),
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
          requirements_enc: Object.keys(restrictedByForm).length
            ? encryptRestricted(
                Buffer.from(
                  JSON.stringify({ version: 1, forms: restrictedByForm }),
                ),
                this.encryption,
              )
            : null,
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
