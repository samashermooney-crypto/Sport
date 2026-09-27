import type { Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg } from '../../db/withOrg.js';

/** Reads only issued invoices billed to the authenticated account in one org. */
export class PostgresPayerInvoices {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(database: Kysely<DB>) {
    this.withOrg = createWithOrg(database);
  }

  async list(input: {
    orgId: string;
    accountId: string;
    beforeNumber?: number;
  }) {
    const context = {
      orgId: input.orgId,
      actor: { accountId: input.accountId },
    };
    return this.withOrg(context, async (trx) => {
      let query = trx
        .selectFrom('invoices')
        .select([
          'id',
          'number',
          'status',
          'source',
          'issued_at',
          'due_on',
          'total_cents',
          'paid_cents',
          'refunded_cents',
          'credit_applied_cents',
          'balance_cents',
        ])
        .where('org_id', '=', input.orgId)
        .where('account_id', '=', input.accountId)
        .where('status', '!=', 'draft');
      if (input.beforeNumber !== undefined)
        query = query.where('number', '<', input.beforeNumber);
      const rows = await query.orderBy('number', 'desc').limit(51).execute();
      const page = rows.slice(0, 50);
      return {
        invoices: page.map((row) => ({
          id: row.id,
          number: row.number,
          status: row.status,
          source: row.source,
          issuedAt: row.issued_at?.toISOString() ?? null,
          dueOn: row.due_on
            ? new Date(row.due_on).toISOString().slice(0, 10)
            : null,
          totalCents: row.total_cents,
          paidCents: row.paid_cents,
          refundedCents: row.refunded_cents,
          creditAppliedCents: row.credit_applied_cents,
          balanceCents: row.balance_cents,
        })),
        nextBeforeNumber:
          rows.length > 50 ? (page[page.length - 1]?.number ?? null) : null,
      };
    });
  }
}
