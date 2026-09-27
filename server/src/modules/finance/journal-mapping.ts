import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import type { JournalAccounts } from './journal-export.js';

const account = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\r\n]/.test(value));
const journalMappingBodySchema = z.strictObject({
  bank: account,
  stripeClearing: account,
  processingFees: account,
  transactionTypes: z
    .record(z.string().regex(/^[a-z_]+$/), account)
    .refine(
      (value) =>
        Object.keys(value).length > 0 && Object.keys(value).length <= 50,
    ),
});
export const journalMappingSaveSchema = journalMappingBodySchema.extend({
  expectedVersion: z.number().int().nonnegative(),
});
export const journalMappingSchema = journalMappingBodySchema.extend({
  version: z.number().int().positive(),
});
export const journalMappingResponseSchema = z.strictObject({
  mapping: journalMappingSchema.nullable(),
});
export type JournalMapping = z.output<typeof journalMappingSchema>;
export class JournalMappingConflictError extends Error {}

interface Row {
  id: string;
  bank: string;
  stripe_clearing: string;
  processing_fees: string;
  transaction_types: unknown;
  version: number;
}

function present(row: Row): JournalMapping {
  return journalMappingSchema.parse({
    bank: row.bank,
    stripeClearing: row.stripe_clearing,
    processingFees: row.processing_fees,
    transactionTypes: row.transaction_types,
    version: row.version,
  });
}

/** The current mapping is versioned; generated journals are read-only previews. */
export class PostgresJournalMapping {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  read(): Promise<JournalMapping | null> {
    return this.withOrg(this.context, async (trx) => {
      const row = await sql<Row>`
        SELECT id, bank, stripe_clearing, processing_fees,
          transaction_types, version FROM payout_journal_mappings
        WHERE org_id = ${this.context.orgId}::uuid
      `.execute(trx);
      return row.rows[0] ? present(row.rows[0]) : null;
    });
  }

  save(
    raw: z.output<typeof journalMappingSaveSchema>,
  ): Promise<JournalMapping> {
    const body = journalMappingSaveSchema.parse(raw);
    return this.withOrg(this.context, async (trx) => {
      const current = await sql<{ id: string; version: number }>`
        SELECT id, version FROM payout_journal_mappings
        WHERE org_id = ${this.context.orgId}::uuid FOR UPDATE
      `.execute(trx);
      const previous = current.rows[0];
      if ((previous?.version ?? 0) !== body.expectedVersion)
        throw new JournalMappingConflictError(
          'Journal mapping version changed',
        );
      let row: Row | undefined;
      if (previous) {
        const result = await sql<Row>`
          UPDATE payout_journal_mappings SET bank = ${body.bank},
            stripe_clearing = ${body.stripeClearing},
            processing_fees = ${body.processingFees},
            transaction_types = ${JSON.stringify(body.transactionTypes)}::jsonb,
            version = version + 1
          WHERE org_id = ${this.context.orgId}::uuid
            AND id = ${previous.id}::uuid
          RETURNING id, bank, stripe_clearing, processing_fees,
            transaction_types, version
        `.execute(trx);
        row = result.rows[0];
      } else {
        try {
          const result = await sql<Row>`
            INSERT INTO payout_journal_mappings
              (id, org_id, bank, stripe_clearing, processing_fees, transaction_types)
            VALUES (${newId()}::uuid, ${this.context.orgId}::uuid,
              ${body.bank}, ${body.stripeClearing}, ${body.processingFees},
              ${JSON.stringify(body.transactionTypes)}::jsonb)
            RETURNING id, bank, stripe_clearing, processing_fees,
              transaction_types, version
          `.execute(trx);
          row = result.rows[0];
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === '23505'
          )
            throw new JournalMappingConflictError(
              'Journal mapping version changed',
            );
          throw error;
        }
      }
      if (!row) throw new Error('Journal mapping missing');
      const mapping = present(row);
      await appendAuditEvent(trx, this.context, {
        action: 'payout_journal_mapping.saved',
        entityType: 'payout_journal_mapping',
        entityId: row.id,
        changes: {
          version: {
            tier: 'internal',
            before: previous?.version ?? 0,
            after: mapping.version,
          },
        },
      });
      return mapping;
    });
  }
}

export function journalAccounts(mapping: JournalMapping): JournalAccounts {
  return {
    bank: mapping.bank,
    stripeClearing: mapping.stripeClearing,
    processingFees: mapping.processingFees,
    transactionTypes: mapping.transactionTypes,
  };
}
