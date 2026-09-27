import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import { allocateOrgNumber } from '../../db/orgCounters.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import {
  initialInvoiceStatus,
  invoiceRequestHash,
  invoiceTotals,
  type IssueInvoiceInput,
} from './invoices.js';

export interface IssuedInvoice {
  id: string;
  orgId: string;
  number: number;
  totalCents: number;
  status: 'open' | 'paid';
}

interface InvoiceRow {
  id: string;
  org_id: string;
  number: number;
  total_cents: number;
  creation_hash: string;
}

class DuplicateInvoice extends Error {}

/** Creates header and lines in one withOrg transaction; the DB reconciles at commit. */
export class PostgresInvoiceRepository {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async issue(input: IssueInvoiceInput): Promise<IssuedInvoice> {
    if (input.orgId !== this.context.orgId) {
      throw new Error('Invoice organization mismatch');
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.creationKey,
      )
    ) {
      throw new Error('Invoice creation key must be a UUID');
    }
    const totals = invoiceTotals(input);
    const hash = invoiceRequestHash(input);
    try {
      return await this.withOrg(this.context, async (trx) => {
        const existing = await sql<InvoiceRow>`
          SELECT id, org_id, number, total_cents, creation_hash
          FROM invoices
          WHERE org_id = ${input.orgId}::uuid
            AND creation_key = ${input.creationKey}::uuid
        `.execute(trx);
        if (existing.rows[0]) return this.replay(existing.rows[0], hash);
        const number = await allocateOrgNumber(trx, input.orgId, 'invoice');
        const id = newId();
        const status = initialInvoiceStatus(totals.totalCents);
        const inserted = await sql<{ id: string }>`
          INSERT INTO invoices
            (id, org_id, number, account_id, status, issued_at, due_on,
             subtotal_cents, discount_cents, service_fee_cents, tax_cents,
             total_cents, memo, source, creation_key, creation_hash)
          VALUES
            (${id}::uuid, ${input.orgId}::uuid, ${number}, ${input.accountId}::uuid,
             ${status}, now(), ${input.dueOn ?? null}::date,
             ${totals.subtotalCents}, ${totals.discountCents},
             ${totals.serviceFeeCents}, ${totals.taxCents},
             ${totals.totalCents}, ${input.memo ?? null}, ${input.source},
             ${input.creationKey}::uuid, ${hash})
          ON CONFLICT DO NOTHING RETURNING id
        `.execute(trx);
        if (!inserted.rows.length) throw new DuplicateInvoice();
        for (const line of input.lines) {
          await trx
            .insertInto('invoice_lines')
            .values({
              id: newId(),
              org_id: input.orgId,
              invoice_id: id,
              kind: line.kind,
              description: line.description,
              quantity: 1,
              unit_amount_cents: line.amountCents,
              amount_cents: line.amountCents,
              refundable: line.refundable,
              tax_rate_bps: line.taxRateBps ?? null,
              registration_id: null,
              person_id: null,
              program_id: null,
              team_season_id: null,
              product_variant_id: null,
              gl_code: null,
              parent_line_id: null,
            })
            .execute();
        }
        return {
          id,
          orgId: input.orgId,
          number,
          totalCents: totals.totalCents,
          status,
        };
      });
    } catch (error) {
      if (!(error instanceof DuplicateInvoice)) throw error;
      return this.withOrg(this.context, async (trx) => {
        const existing = await sql<InvoiceRow>`
          SELECT id, org_id, number, total_cents, creation_hash
          FROM invoices WHERE org_id = ${input.orgId}::uuid
            AND creation_key = ${input.creationKey}::uuid
        `.execute(trx);
        const row = existing.rows[0];
        if (!row)
          throw new Error('Invoice creation conflicted without a matching key');
        return this.replay(row, hash);
      });
    }
  }

  private replay(row: InvoiceRow, hash: string): IssuedInvoice {
    if (row.creation_hash !== hash) {
      throw new Error('Invoice creation key was used for a different request');
    }
    return {
      id: row.id,
      orgId: row.org_id,
      number: row.number,
      totalCents: row.total_cents,
      status: initialInvoiceStatus(row.total_cents),
    };
  }
}
