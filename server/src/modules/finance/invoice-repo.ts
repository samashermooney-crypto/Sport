import { deriveInvoiceState } from '@shared/algorithms/invoice-state';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import { allocateOrgNumber } from '../../db/orgCounters.js';
import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import {
  initialInvoiceStatus,
  invoiceRequestHash,
  invoiceTotals,
  type IssueInvoiceInput,
} from './invoices.js';
import { enqueueFinanceNotice } from './money-notices.js';
import { refundTermsSchema } from './refund-terms.js';

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

export class InvoiceConflictError extends Error {
  readonly status = 409;
}

export class InvoiceNotFoundError extends Error {
  readonly status = 404;
}

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
    const refundTerms = input.refundTerms
      ? refundTermsSchema.parse(input.refundTerms)
      : null;
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
            (id, org_id, number, account_id, household_id, status, issued_at, due_on,
             subtotal_cents, discount_cents, service_fee_cents, tax_cents,
             total_cents, memo, source, creation_key, creation_hash, refund_terms)
          VALUES
            (${id}::uuid, ${input.orgId}::uuid, ${number}, ${input.accountId}::uuid,
             ${input.householdId ?? null}::uuid,
             ${status}, now(), ${input.dueOn ?? null}::date,
             ${totals.subtotalCents}, ${totals.discountCents},
             ${totals.serviceFeeCents}, ${totals.taxCents},
             ${totals.totalCents}, ${input.memo ?? null}, ${input.source},
             ${input.creationKey}::uuid, ${hash},
             ${refundTerms ? JSON.stringify(refundTerms) : null}::jsonb)
          ON CONFLICT DO NOTHING RETURNING id
        `.execute(trx);
        if (!inserted.rows.length) throw new DuplicateInvoice();
        const lineIds = input.lines.map(() => newId());
        for (const [index, line] of input.lines.entries()) {
          const lineId = lineIds[index];
          if (!lineId) throw new Error('Invoice line ID is missing');
          const parentLineId =
            line.parentLineIndex === undefined
              ? null
              : lineIds[line.parentLineIndex];
          await trx
            .insertInto('invoice_lines')
            .values({
              id: lineId,
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
              parent_line_id: parentLineId ?? null,
            })
            .execute();
        }
        await appendAuditEvent(trx, this.context, {
          action: 'invoice.issued',
          entityType: 'invoice',
          entityId: id,
          changes: {
            totalCents: { tier: 'internal', after: totals.totalCents },
            number: { tier: 'internal', after: number },
          },
        });
        await enqueueFinanceNotice(trx, this.context, {
          kind: 'invoice_issued',
          sourceId: id,
          accountId: input.accountId,
        });
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

  async void(input: {
    orgId: string;
    invoiceId: string;
    reason: string;
    expectedVersion?: number;
  }): Promise<void> {
    if (input.orgId !== this.context.orgId)
      throw new Error('Invoice organization mismatch');
    if (!input.reason.trim())
      throw new Error('Invoice void reason is required');
    await this.withOrg(this.context, async (trx) => {
      const invoice = await trx
        .selectFrom('invoices')
        .select([
          'id',
          'status',
          'total_cents',
          'paid_cents',
          'refunded_cents',
          'credit_applied_cents',
          'disputed_cents',
          'dispute_lost_cents',
          'void_reason',
          'version',
        ])
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.invoiceId)
        .forUpdate()
        .executeTakeFirst();
      if (!invoice) throw new InvoiceNotFoundError('Invoice not found');
      if (invoice.status === 'void') {
        if (invoice.void_reason !== input.reason)
          throw new InvoiceConflictError(
            'Invoice was voided for a different reason',
          );
        return;
      }
      if (
        input.expectedVersion !== undefined &&
        invoice.version !== input.expectedVersion
      )
        throw new InvoiceConflictError('Invoice version changed');
      if (
        invoice.paid_cents !== invoice.refunded_cents ||
        invoice.credit_applied_cents !== 0 ||
        invoice.disputed_cents !== 0 ||
        invoice.dispute_lost_cents !== 0
      )
        throw new InvoiceConflictError(
          'Cannot void invoice with net money or dispute',
        );
      const unsettled = await sql<{ count: number }>`
        SELECT count(*)::integer AS count FROM payment_allocations pa
        JOIN payments p ON p.org_id = pa.org_id AND p.id = pa.payment_id
        WHERE pa.org_id = ${input.orgId}::uuid
          AND pa.invoice_id = ${input.invoiceId}::uuid
          AND p.status IN ('requires_action', 'processing')
      `.execute(trx);
      if ((unsettled.rows[0]?.count ?? 0) > 0)
        throw new InvoiceConflictError(
          'Cannot void invoice with unsettled payment',
        );
      const installments = await trx
        .selectFrom('installments')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('invoice_id', '=', input.invoiceId)
        .where('status', 'in', ['scheduled', 'processing'])
        .executeTakeFirst();
      if (installments)
        throw new InvoiceConflictError(
          'Cannot void invoice with active installments',
        );
      deriveInvoiceState({
        totalCents: invoice.total_cents,
        succeededAllocationsCents: invoice.paid_cents,
        refundedToMethodCents: invoice.refunded_cents,
        creditAppliedCents: invoice.credit_applied_cents,
        todayLocal: '1970-01-01',
        confirmed: true,
        voided: true,
      });
      await trx
        .updateTable('invoices')
        .set({
          status: 'void',
          voided_at: new Date(),
          void_reason: input.reason,
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.invoiceId)
        .execute();
      await appendAuditEvent(trx, this.context, {
        action: 'invoice.voided',
        entityType: 'invoice',
        entityId: input.invoiceId,
        changes: { reason: { tier: 'internal', after: input.reason } },
      });
    });
  }

  async read(orgId: string, invoiceId: string) {
    if (orgId !== this.context.orgId)
      throw new Error('Invoice organization mismatch');
    return this.withOrg(this.context, async (trx) => {
      const invoice = await trx
        .selectFrom('invoices')
        .select([
          'id',
          'number',
          'account_id',
          'household_id',
          'status',
          'issued_at',
          'due_on',
          'subtotal_cents',
          'discount_cents',
          'service_fee_cents',
          'tax_cents',
          'total_cents',
          'paid_cents',
          'refunded_cents',
          'credit_applied_cents',
          'balance_cents',
          'memo',
          'source',
          'version',
          'voided_at',
          'void_reason',
        ])
        .where('org_id', '=', orgId)
        .where('id', '=', invoiceId)
        .executeTakeFirst();
      if (!invoice) throw new InvoiceNotFoundError('Invoice not found');
      const lines = await trx
        .selectFrom('invoice_lines')
        .select([
          'id',
          'kind',
          'description',
          'amount_cents',
          'refundable',
          'parent_line_id',
        ])
        .where('org_id', '=', orgId)
        .where('invoice_id', '=', invoiceId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return {
        id: invoice.id,
        number: invoice.number,
        accountId: invoice.account_id,
        householdId: invoice.household_id,
        status: invoice.status,
        issuedAt: invoice.issued_at?.toISOString() ?? null,
        dueOn: invoice.due_on
          ? new Date(invoice.due_on).toISOString().slice(0, 10)
          : null,
        subtotalCents: invoice.subtotal_cents,
        discountCents: invoice.discount_cents,
        serviceFeeCents: invoice.service_fee_cents,
        taxCents: invoice.tax_cents,
        totalCents: invoice.total_cents,
        paidCents: invoice.paid_cents,
        refundedCents: invoice.refunded_cents,
        creditAppliedCents: invoice.credit_applied_cents,
        balanceCents: invoice.balance_cents,
        memo: invoice.memo,
        source: invoice.source,
        version: invoice.version,
        voidedAt: invoice.voided_at?.toISOString() ?? null,
        voidReason: invoice.void_reason,
        lines: lines.map((line) => ({
          id: line.id,
          kind: line.kind,
          description: line.description,
          amountCents: line.amount_cents,
          refundable: line.refundable,
          parentLineId: line.parent_line_id,
        })),
      };
    });
  }

  private replay(row: InvoiceRow, hash: string): IssuedInvoice {
    if (row.creation_hash !== hash) {
      throw new InvoiceConflictError(
        'Invoice creation key was used for a different request',
      );
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

/** Call inside the same withOrg transaction as allocation/refund/credit writes. */
export async function recomputeInvoiceStatus(
  trx: OrgTransaction,
  orgId: string,
  invoiceId: string,
  todayLocal: string,
): Promise<string> {
  const invoice = await sql<{
    status: string;
    total_cents: number;
    paid_cents: number;
    refunded_cents: number;
    disputed_cents: number;
    dispute_lost_cents: number;
    credit_applied_cents: number;
    balance_cents: number;
    due_on: string | null;
  }>`
    SELECT status, total_cents, paid_cents, refunded_cents,
           disputed_cents, dispute_lost_cents,
           credit_applied_cents, balance_cents, due_on::text
    FROM invoices WHERE org_id = ${orgId}::uuid AND id = ${invoiceId}::uuid
    FOR UPDATE
  `.execute(trx);
  const row = invoice.rows[0];
  if (!row) throw new Error('Invoice not found');
  if (row.status === 'draft') return 'draft';
  const installments = await sql<{
    due_on: string;
    amount_cents: number;
    paid_cents: number;
  }>`
    SELECT due_on::text, amount_cents, paid_cents FROM installments
    WHERE org_id = ${orgId}::uuid AND invoice_id = ${invoiceId}::uuid
      AND status NOT IN ('waived', 'canceled')
  `.execute(trx);
  const state = deriveInvoiceState({
    totalCents: row.total_cents,
    succeededAllocationsCents: row.paid_cents,
    refundedToMethodCents: row.refunded_cents + row.dispute_lost_cents,
    disputedCents: row.disputed_cents,
    creditAppliedCents: row.credit_applied_cents,
    installments: installments.rows.map((item) => ({
      dueOn: item.due_on,
      amountCents: item.amount_cents,
      paidCents: item.paid_cents,
    })),
    dueOn: row.due_on,
    todayLocal,
    confirmed: true,
    voided: row.status === 'void',
  });
  if (state.balanceCents !== row.balance_cents) {
    throw new Error('Invoice balance differs from derived state');
  }
  if (state.status !== row.status) {
    await trx
      .updateTable('invoices')
      .set({ status: state.status, version: sql`version + 1` })
      .where('org_id', '=', orgId)
      .where('id', '=', invoiceId)
      .execute();
  }
  return state.status;
}
