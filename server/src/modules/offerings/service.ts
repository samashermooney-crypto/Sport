import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types';
import { createWithOrg, type OrgContext } from '../../db/withOrg';
import { PostgresInstallmentTemplates } from '../finance/installment-templates';
import { requireStaff } from '../people/repo';

export const offeringPricingSchema = z
  .strictObject({
    earlyPriceCents: z.number().int().nonnegative().optional(),
    earlyEndsAt: z.iso.datetime({ offset: true }).optional(),
    latePriceCents: z.number().int().nonnegative().optional(),
    lateStartsAt: z.iso.datetime({ offset: true }).optional(),
    installmentTemplateIds: z.array(z.uuid()).default([]),
    siblingDiscountEligible: z.boolean().default(true),
    glCode: z.string().trim().max(40).nullable().default(null),
  })
  .superRefine((pricing, ctx) => {
    if (
      (pricing.earlyPriceCents === undefined) !==
      (pricing.earlyEndsAt === undefined)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Early price and early end time must be set together',
        path: ['earlyPriceCents'],
      });
    if (
      (pricing.latePriceCents === undefined) !==
      (pricing.lateStartsAt === undefined)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Late price and late start time must be set together',
        path: ['latePriceCents'],
      });
    if (
      pricing.earlyEndsAt &&
      pricing.lateStartsAt &&
      Date.parse(pricing.earlyEndsAt) >= Date.parse(pricing.lateStartsAt)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Early pricing must end before late pricing starts',
        path: ['lateStartsAt'],
      });
  });

const addOnOptionSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  label: z.string().trim().min(1).max(80),
});
export const offeringAddOnSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    priceCents: z.number().int().nonnegative(),
    required: z.boolean().default(false),
    options: z.array(addOnOptionSchema).default([]),
  })
  .superRefine((addOn, ctx) => {
    if (
      new Set(addOn.options.map((option) => option.key)).size !==
      addOn.options.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Add-on option keys must be unique',
        path: ['options'],
      });
  });
const addOnsSchema = z
  .array(offeringAddOnSchema)
  .default([])
  .superRefine((addOns, ctx) => {
    if (new Set(addOns.map((addOn) => addOn.key)).size !== addOns.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Add-on keys must be unique within an offering',
      });
  });
export const offeringInputSchema = z.strictObject({
  programId: z.uuid(),
  divisionId: z.uuid().nullable().default(null),
  name: z.string().trim().min(1).max(120),
  registrantRole: z.enum([
    'athlete',
    'coach',
    'volunteer',
    'team_entry',
    'official',
  ]),
  priceCents: z.number().int().nonnegative(),
  pricing: offeringPricingSchema.default({
    installmentTemplateIds: [],
    siblingDiscountEligible: true,
    glCode: null,
  }),
  capacity: z.number().int().nonnegative().nullable().default(null),
  waitlistEnabled: z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
  formDefinitionIds: z.array(z.uuid()).default([]),
  waiverDocumentIds: z.array(z.uuid()).default([]),
  addOns: addOnsSchema,
  visibility: z
    .enum(['public', 'invite_only', 'staff_only'])
    .default('staff_only'),
  active: z.boolean().default(false),
});
export const offeringUpdateSchema = offeringInputSchema
  .omit({ programId: true })
  .partial()
  .extend({ expectedVersion: z.number().int().positive() });
export class OfferingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class OfferingsService {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    private readonly database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }
  private async checkTemplates(ids: string[]): Promise<void> {
    const unique = new Set(ids);
    if (unique.size !== ids.length)
      throw new OfferingError(
        400,
        'VALIDATION_ERROR',
        'Duplicate installment plan',
      );
    if (ids.length === 0) return;
    const available = await new PostgresInstallmentTemplates(
      this.database,
      this.context,
    ).list(true);
    if (ids.some((id) => !available.some((template) => template.id === id)))
      throw new OfferingError(
        400,
        'VALIDATION_ERROR',
        'Choose active installment plans from this organization',
      );
  }
  list(programId: string) {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      return trx
        .selectFrom('registration_offerings')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('program_id', '=', programId)
        .orderBy('sort_order')
        .execute();
    });
  }
  async create(input: z.input<typeof offeringInputSchema>) {
    const value = offeringInputSchema.parse(input);
    await this.checkTemplates(value.pricing.installmentTemplateIds);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const program = await trx
        .selectFrom('programs')
        .select('id')
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', value.programId)
        .executeTakeFirst();
      if (!program)
        throw new OfferingError(404, 'NOT_FOUND', 'Program not found');
      if (value.divisionId) {
        const division = await trx
          .selectFrom('divisions')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('program_id', '=', value.programId)
          .where('id', '=', value.divisionId)
          .executeTakeFirst();
        if (!division)
          throw new OfferingError(
            400,
            'VALIDATION_ERROR',
            'Division must belong to this program',
          );
      }
      const id = newId();
      const row = await trx
        .insertInto('registration_offerings')
        .values({
          id,
          org_id: this.context.orgId,
          program_id: value.programId,
          division_id: value.divisionId,
          name: value.name,
          registrant_role: value.registrantRole,
          price_cents: value.priceCents,
          pricing: value.pricing as Json,
          capacity: value.capacity,
          waitlist_enabled: value.waitlistEnabled,
          requires_approval: value.requiresApproval,
          form_definition_ids: value.formDefinitionIds,
          waiver_document_ids: value.waiverDocumentIds,
          add_ons: JSON.stringify(value.addOns) as unknown as Json,
          visibility: value.visibility,
          active: value.active,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('capacity_counters')
        .values({
          id: newId(),
          org_id: this.context.orgId,
          subject_type: 'offering',
          subject_id: id,
          capacity: value.capacity,
        })
        .execute();
      return row;
    });
  }
  async update(id: string, input: z.input<typeof offeringUpdateSchema>) {
    const value = offeringUpdateSchema.parse(input);
    if (value.pricing)
      await this.checkTemplates(value.pricing.installmentTemplateIds);
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const current = await trx
        .selectFrom('registration_offerings')
        .selectAll()
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new OfferingError(404, 'NOT_FOUND', 'Offering not found');
      if (current.version !== value.expectedVersion)
        throw new OfferingError(
          409,
          'VERSION_CONFLICT',
          'Offering changed; reload before saving',
        );
      if (value.divisionId) {
        const division = await trx
          .selectFrom('divisions')
          .select('id')
          .where('org_id', '=', this.context.orgId)
          .where('program_id', '=', current.program_id)
          .where('id', '=', value.divisionId)
          .executeTakeFirst();
        if (!division)
          throw new OfferingError(
            400,
            'VALIDATION_ERROR',
            'Division must belong to this program',
          );
      }
      if (value.capacity !== undefined) {
        const counter = await trx
          .selectFrom('capacity_counters')
          .select(['confirmed', 'held'])
          .where('org_id', '=', this.context.orgId)
          .where('subject_type', '=', 'offering')
          .where('subject_id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (
          counter &&
          value.capacity !== null &&
          value.capacity < counter.confirmed + counter.held
        )
          throw new OfferingError(
            409,
            'CONFLICT',
            'Capacity cannot fall below confirmed and held places',
          );
        await trx
          .updateTable('capacity_counters')
          .set({ capacity: value.capacity })
          .where('org_id', '=', this.context.orgId)
          .where('subject_type', '=', 'offering')
          .where('subject_id', '=', id)
          .execute();
      }
      return trx
        .updateTable('registration_offerings')
        .set({
          ...(value.divisionId === undefined
            ? {}
            : { division_id: value.divisionId }),
          ...(value.name === undefined ? {} : { name: value.name }),
          ...(value.registrantRole === undefined
            ? {}
            : { registrant_role: value.registrantRole }),
          ...(value.priceCents === undefined
            ? {}
            : { price_cents: value.priceCents }),
          ...(value.pricing === undefined
            ? {}
            : { pricing: value.pricing as Json }),
          ...(value.capacity === undefined ? {} : { capacity: value.capacity }),
          ...(value.waitlistEnabled === undefined
            ? {}
            : { waitlist_enabled: value.waitlistEnabled }),
          ...(value.requiresApproval === undefined
            ? {}
            : { requires_approval: value.requiresApproval }),
          ...(value.formDefinitionIds === undefined
            ? {}
            : { form_definition_ids: value.formDefinitionIds }),
          ...(value.waiverDocumentIds === undefined
            ? {}
            : { waiver_document_ids: value.waiverDocumentIds }),
          ...(value.addOns === undefined
            ? {}
            : {
                add_ons: JSON.stringify(value.addOns) as unknown as Json,
              }),
          ...(value.visibility === undefined
            ? {}
            : { visibility: value.visibility }),
          ...(value.active === undefined ? {} : { active: value.active }),
          version: current.version + 1,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  templates() {
    return new PostgresInstallmentTemplates(this.database, this.context).list(
      true,
    );
  }
  pricingContext() {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const organization = await trx
        .selectFrom('organizations')
        .select('timezone')
        .where('id', '=', this.context.orgId)
        .executeTakeFirst();
      if (!organization)
        throw new OfferingError(404, 'NOT_FOUND', 'Organization not found');
      return { timezone: organization.timezone };
    });
  }
  libraries() {
    return this.withOrg(this.context, async (trx) => {
      await requireStaff(
        trx,
        this.context.orgId,
        this.context.actor.accountId,
        false,
      );
      const [forms, waivers] = await Promise.all([
        trx
          .selectFrom('form_definitions')
          .select(['id', 'name', 'scope', 'version'])
          .where('org_id', '=', this.context.orgId)
          .where('published_at', 'is not', null)
          .where('retired_at', 'is', null)
          .orderBy('name')
          .execute(),
        trx
          .selectFrom('waiver_documents')
          .select(['id', 'name', 'requires', 'renewal', 'version'])
          .where('org_id', '=', this.context.orgId)
          .where('published_at', 'is not', null)
          .where('retired_at', 'is', null)
          .orderBy('name')
          .execute(),
      ]);
      return { forms, waivers };
    });
  }
}
