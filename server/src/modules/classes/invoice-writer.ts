import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql } from 'kysely';

import { allocateOrgNumber } from '../../db/orgCounters.js';
import type { OrgContext, OrgTransaction } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';
import {
  initialInvoiceStatus,
  invoiceRequestHash,
  invoiceTotals,
  type IssueInvoiceInput,
} from '../finance/invoices.js';
import { enqueueFinanceNotice } from '../finance/money-notices.js';
import { refundTermsSchema } from '../finance/refund-terms.js';

/**
 * Invoice issuance that shares the caller's withOrg transaction so tuition
 * billing stays atomic with enrollment/subscription writes. Reuses Track E's
 * totals, request-hash and initial-status functions so invoice semantics are
 * identical to PostgresInvoiceRepository.issue().
 */
export async function issueInvoiceInTransaction(
  trx: OrgTransaction,
  context: OrgContext,
  input: IssueInvoiceInput,
): Promise<{ id: string; number: number; totalCents: number }> {
  if (input.orgId !== context.orgId)
    throw new Error('Invoice organization mismatch');
  const totals = invoiceTotals(input);
  const hash = invoiceRequestHash(input);
  const existing = await sql<{
    id: string;
    number: number;
    total_cents: number;
    creation_hash: string;
  }>`
    SELECT id, number, total_cents, creation_hash FROM invoices
    WHERE org_id = ${input.orgId}::uuid
      AND creation_key = ${input.creationKey}::uuid
  `.execute(trx);
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.creation_hash !== hash)
      throw new Error('Invoice creation key was reused');
    return { id: row.id, number: row.number, totalCents: row.total_cents };
  }
  const number = await allocateOrgNumber(trx, input.orgId, 'invoice');
  const id = newId();
  const status = initialInvoiceStatus(totals.totalCents);
  const refundTerms = input.refundTerms
    ? refundTermsSchema.parse(input.refundTerms)
    : null;
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
  if (!inserted.rows.length) throw new Error('Invoice insert conflicted');
  const lineIds = input.lines.map(() => newId());
  for (const [index, line] of input.lines.entries()) {
    const lineId = lineIds[index];
    if (!lineId) throw new Error('Invoice line ID is missing');
    const parentLineId =
      line.parentLineIndex === undefined ? null : lineIds[line.parentLineIndex];
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
  await appendAuditEvent(trx, context, {
    action: 'invoice.issued',
    entityType: 'invoice',
    entityId: id,
    changes: {
      totalCents: { tier: 'internal', after: totals.totalCents },
      number: { tier: 'internal', after: number },
    },
  });
  await enqueueFinanceNotice(trx, context, {
    kind: 'invoice_issued',
    sourceId: id,
    accountId: input.accountId,
  });
  return { id, number, totalCents: totals.totalCents };
}

function creditRequestHash(input: {
  accountId: string | null;
  householdId: string | null;
  amountCents: number;
  source: string;
  expiresOn: string | null;
  note: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.accountId,
        input.householdId,
        input.amountCents,
        input.source,
        input.expiresOn,
        input.note,
      ]),
    )
    .digest('hex');
}

/**
 * Issue a household credit inside the caller's transaction (mirrors
 * PostgresCreditLedger.issue so balances/apply queries keep working).
 */
export async function issueCreditInTransaction(
  trx: OrgTransaction,
  context: OrgContext,
  input: {
    householdId: string;
    amountCents: number;
    source: string;
    note?: string;
    operationKey: string;
    expiresOn?: string | null;
  },
): Promise<string | null> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1)
    return null;
  const hash = creditRequestHash({
    accountId: null,
    householdId: input.householdId,
    amountCents: input.amountCents,
    source: input.source,
    expiresOn: input.expiresOn ?? null,
    note: input.note ?? null,
  });
  const inserted = await sql<{ id: string }>`
    INSERT INTO credits
      (id, org_id, account_id, household_id, amount_cents, kind, source,
       expires_on, note, created_by, operation_key, operation_line, request_hash)
    VALUES
      (${newId()}::uuid, ${context.orgId}::uuid, NULL,
       ${input.householdId}::uuid, ${input.amountCents}, 'issued',
       ${input.source}, ${input.expiresOn ?? null}::date,
       ${input.note ?? null}, ${context.actor.accountId}::uuid,
       ${input.operationKey}::uuid, 0, ${hash})
    ON CONFLICT DO NOTHING RETURNING id
  `.execute(trx);
  if (inserted.rows[0]) {
    await appendAuditEvent(trx, context, {
      action: 'credit.issued',
      entityType: 'credit',
      entityId: inserted.rows[0].id,
      changes: {
        amountCents: { tier: 'internal', after: input.amountCents },
      },
    });
    return inserted.rows[0].id;
  }
  const existing = await sql<{ id: string }>`
    SELECT id FROM credits
    WHERE org_id = ${context.orgId}::uuid
      AND operation_key = ${input.operationKey}::uuid AND operation_line = 0
  `.execute(trx);
  return existing.rows[0]?.id ?? null;
}
