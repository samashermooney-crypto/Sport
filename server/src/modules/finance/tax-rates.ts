import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

export const taxRateBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  rateBps: z.number().int().min(0).max(10_000),
  active: z.boolean(),
});
export const taxRateReplaceSchema = taxRateBodySchema.extend({
  expectedVersion: z.number().int().positive(),
});
export const taxRateSchema = taxRateBodySchema.extend({
  id: z.uuid(),
  version: z.number().int().positive(),
  appliesTo: z.literal('products'),
});
export const taxRateListSchema = z.strictObject({
  taxRates: z.array(taxRateSchema),
});
export type ProductTaxRate = z.output<typeof taxRateSchema>;
export class TaxRateConflictError extends Error {}

interface TaxRateRow {
  id: string;
  name: string;
  rate_bps: number;
  applies_to: string;
  active: boolean;
  version: number;
  creation_hash: string | null;
}

function view(row: TaxRateRow): ProductTaxRate {
  return taxRateSchema.parse({
    id: row.id,
    name: row.name,
    rateBps: row.rate_bps,
    appliesTo: row.applies_to,
    active: row.active,
    version: row.version,
  });
}

/** Keeps tax configuration versioned; invoice tax lines freeze rates at issuance. */
export class PostgresProductTaxRates {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async create(
    input: z.output<typeof taxRateBodySchema>,
    creationKey: string,
  ): Promise<ProductTaxRate> {
    const body = taxRateBodySchema.parse(input);
    const key = z.uuid().parse(creationKey);
    const requestHash = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    return this.withOrg(this.context, async (trx) => {
      const inserted = await sql<TaxRateRow>`
        INSERT INTO tax_rates (id, org_id, name, rate_bps,
          applies_to, active, creation_key, creation_hash)
        VALUES (${newId()}::uuid, ${this.context.orgId}::uuid,
          ${body.name}, ${body.rateBps}, 'products', ${body.active},
          ${key}::uuid, ${requestHash})
        ON CONFLICT (org_id, creation_key) WHERE creation_key IS NOT NULL
          DO NOTHING RETURNING *
      `.execute(trx);
      const row = inserted.rows[0];
      if (row) {
        await appendAuditEvent(trx, this.context, {
          action: 'tax_rate.created',
          entityType: 'tax_rate',
          entityId: row.id,
          changes: { rateBps: { tier: 'internal', after: body.rateBps } },
        });
        return view(row);
      }
      const replay = await sql<TaxRateRow>`
        SELECT * FROM tax_rates WHERE org_id = ${this.context.orgId}::uuid
          AND creation_key = ${key}::uuid
      `.execute(trx);
      const existing = replay.rows[0];
      if (!existing || existing.creation_hash !== requestHash)
        throw new TaxRateConflictError('Tax rate creation key was reused');
      return view(existing);
    });
  }

  async replace(
    id: string,
    input: z.output<typeof taxRateReplaceSchema>,
  ): Promise<ProductTaxRate> {
    const rateId = z.uuid().parse(id);
    const body = taxRateReplaceSchema.parse(input);
    return this.withOrg(this.context, async (trx) => {
      const current = await trx
        .selectFrom('tax_rates')
        .select(['id', 'rate_bps', 'version'])
        .where('org_id', '=', this.context.orgId)
        .where('id', '=', rateId)
        .forUpdate()
        .executeTakeFirst();
      if (!current || current.version !== body.expectedVersion)
        throw new TaxRateConflictError('Tax rate version changed');
      const updated = await sql<TaxRateRow>`
        UPDATE tax_rates SET name = ${body.name},
          rate_bps = ${body.rateBps}, active = ${body.active},
          version = version + 1
        WHERE org_id = ${this.context.orgId}::uuid
          AND id = ${rateId}::uuid RETURNING *
      `.execute(trx);
      const row = updated.rows[0];
      if (!row) throw new TaxRateConflictError('Tax rate changed');
      await appendAuditEvent(trx, this.context, {
        action: 'tax_rate.replaced',
        entityType: 'tax_rate',
        entityId: rateId,
        changes: {
          rateBps: {
            tier: 'internal',
            before: current.rate_bps,
            after: body.rateBps,
          },
        },
      });
      return view(row);
    });
  }

  async list(): Promise<ProductTaxRate[]> {
    return this.withOrg(this.context, async (trx) => {
      const rows = await sql<TaxRateRow>`
        SELECT * FROM tax_rates WHERE org_id = ${this.context.orgId}::uuid
        ORDER BY name, id
      `.execute(trx);
      return rows.rows.map(view);
    });
  }

  async resolveActive(rateId: string): Promise<ProductTaxRate> {
    const id = z.uuid().parse(rateId);
    return this.withOrg(this.context, async (trx) => {
      const row = await sql<TaxRateRow>`
        SELECT * FROM tax_rates WHERE org_id = ${this.context.orgId}::uuid
          AND id = ${id}::uuid AND applies_to = 'products'
          AND active = true
      `.execute(trx);
      if (!row.rows[0])
        throw new TaxRateConflictError('Active product tax rate unavailable');
      return view(row.rows[0]);
    });
  }
}
