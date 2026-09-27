import { generateInstallments } from '@shared/algorithms/installments';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

const cents = z.number().int().nonnegative();
export const installmentTemplateBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  deposit: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('fixed'), amountCents: cents }),
    z.strictObject({ kind: z.literal('percent'), bps: cents.max(10_000) }),
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
  minAmountCents: cents,
  autopayRequired: z.boolean(),
  allowedMethods: z
    .array(z.enum(['card', 'us_bank_account']))
    .min(1)
    .max(2),
});
export const installmentTemplateSchema = installmentTemplateBodySchema.extend({
  id: z.uuid(),
  version: z.number().int().positive(),
  active: z.boolean(),
});
export const installmentTemplateListSchema = z.strictObject({
  templates: z.array(installmentTemplateSchema),
});
export type InstallmentTemplateInput = z.output<
  typeof installmentTemplateBodySchema
>;
export type StoredInstallmentTemplate = z.output<
  typeof installmentTemplateSchema
>;

export class InstallmentTemplateConflictError extends Error {}

function validate(input: InstallmentTemplateInput): InstallmentTemplateInput {
  const template = installmentTemplateBodySchema.parse(input);
  if (new Set(template.allowedMethods).size !== template.allowedMethods.length)
    throw new RangeError('Duplicate installment payment method');
  if (template.schedule.kind === 'fixed_dates') {
    const dates = template.schedule.dates;
    if (
      dates.some((date, index) => index > 0 && date <= (dates[index - 1] ?? ''))
    )
      throw new RangeError('Installment dates must be strictly increasing');
  }
  // Shared algorithm validates the schedule's financial shape without storing a quote.
  generateInstallments(
    10_000,
    {
      deposit: template.deposit,
      schedule: template.schedule,
      minAmountCents: template.minAmountCents,
    },
    '2026-01-01',
  );
  return template;
}

function present(row: {
  id: string;
  name: string;
  deposit: Json;
  schedule: Json;
  min_amount_cents: number;
  autopay_required: boolean;
  allowed_methods: string[];
  version: number;
  active: boolean;
}): StoredInstallmentTemplate {
  return installmentTemplateSchema.parse({
    id: row.id,
    name: row.name,
    deposit: row.deposit,
    schedule: row.schedule,
    minAmountCents: row.min_amount_cents,
    autopayRequired: row.autopay_required,
    allowedMethods: row.allowed_methods,
    version: row.version,
    active: row.active,
  });
}

/** Templates are versioned and archived, never hard-deleted. */
export class PostgresInstallmentTemplates {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  list(activeOnly: boolean): Promise<StoredInstallmentTemplate[]> {
    return this.withOrg(this.context, async (trx) => {
      let query = trx
        .selectFrom('installment_plan_templates')
        .select([
          'id',
          'name',
          'deposit',
          'schedule',
          'min_amount_cents',
          'autopay_required',
          'allowed_methods',
          'version',
          'active',
        ])
        .where('org_id', '=', this.context.orgId);
      if (activeOnly) query = query.where('active', '=', true);
      const rows = await query.orderBy('name').orderBy('id').execute();
      return rows.map(present);
    });
  }

  async create(
    input: InstallmentTemplateInput,
  ): Promise<StoredInstallmentTemplate> {
    const template = validate(input);
    return this.withOrg(this.context, async (trx) => {
      const id = newId();
      const row = await trx
        .insertInto('installment_plan_templates')
        .values({
          id,
          org_id: this.context.orgId,
          name: template.name,
          kind: template.schedule.kind,
          deposit: template.deposit as Json,
          schedule: template.schedule as Json,
          min_amount_cents: template.minAmountCents,
          autopay_required: template.autopayRequired,
          allowed_methods: template.allowedMethods,
        })
        .returning([
          'id',
          'name',
          'deposit',
          'schedule',
          'min_amount_cents',
          'autopay_required',
          'allowed_methods',
          'version',
          'active',
        ])
        .executeTakeFirstOrThrow();
      await appendAuditEvent(trx, this.context, {
        action: 'installment_template.created',
        entityType: 'installment_template',
        entityId: id,
        changes: { name: { tier: 'internal', after: template.name } },
      });
      return present(row);
    });
  }

  async replace(
    id: string,
    version: number,
    input: InstallmentTemplateInput,
  ): Promise<StoredInstallmentTemplate> {
    const template = validate(input);
    return this.withOrg(this.context, async (trx) => {
      const row = await trx
        .updateTable('installment_plan_templates')
        .set({
          name: template.name,
          kind: template.schedule.kind,
          deposit: template.deposit as Json,
          schedule: template.schedule as Json,
          min_amount_cents: template.minAmountCents,
          autopay_required: template.autopayRequired,
          allowed_methods: template.allowedMethods,
          version: sql`version + 1`,
        })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .where('version', '=', version)
        .where('active', '=', true)
        .returning([
          'id',
          'name',
          'deposit',
          'schedule',
          'min_amount_cents',
          'autopay_required',
          'allowed_methods',
          'version',
          'active',
        ])
        .executeTakeFirst();
      if (!row)
        throw new InstallmentTemplateConflictError(
          'Installment template changed or was archived',
        );
      await appendAuditEvent(trx, this.context, {
        action: 'installment_template.replaced',
        entityType: 'installment_template',
        entityId: id,
        changes: {
          version: { tier: 'internal', before: version, after: row.version },
        },
      });
      return present(row);
    });
  }

  archive(id: string, version: number): Promise<void> {
    return this.withOrg(this.context, async (trx) => {
      const row = await trx
        .updateTable('installment_plan_templates')
        .set({ active: false, version: sql`version + 1` })
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', id)
        .where('version', '=', version)
        .where('active', '=', true)
        .returning('id')
        .executeTakeFirst();
      if (!row)
        throw new InstallmentTemplateConflictError(
          'Installment template changed or was archived',
        );
      await appendAuditEvent(trx, this.context, {
        action: 'installment_template.archived',
        entityType: 'installment_template',
        entityId: id,
        changes: { active: { tier: 'internal', before: true, after: false } },
      });
    });
  }
}
