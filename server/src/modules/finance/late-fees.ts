import { newId } from '@shared/ids';
import { sql } from 'kysely';

import type { OrgContext, OrgTransaction } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

const MAX_LATE_FEE_CENTS = 10_000;

function configuredLateFee(settings: unknown): number {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error('Organization money settings are invalid');
  const value = (settings as Record<string, unknown>).lateFeeCents;
  if (value === undefined) return 0;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_LATE_FEE_CENTS
  )
    throw new Error('Organization late fee must be 0–10000 cents');
  return value;
}

/** Called in the payment event transaction after a final automatic failure. */
export async function applyFinalInstallmentLateFee(
  trx: OrgTransaction,
  context: OrgContext,
  input: { invoiceId: string; installmentId: string },
): Promise<boolean> {
  const org = await trx
    .selectFrom('organizations')
    .select('settings')
    .where('id', '=', context.orgId)
    .executeTakeFirstOrThrow();
  const amountCents = configuredLateFee(org.settings);
  if (amountCents === 0) return false;
  const invoice = await trx
    .selectFrom('invoices')
    .select(['id', 'status'])
    .where('org_id', '=', context.orgId)
    .where('id', '=', input.invoiceId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (invoice.status === 'void' || invoice.status === 'paid') return false;
  const installment = await trx
    .selectFrom('installments')
    .select(['invoice_id', 'status', 'autopay'])
    .where('org_id', '=', context.orgId)
    .where('id', '=', input.installmentId)
    .executeTakeFirstOrThrow();
  if (
    installment.invoice_id !== input.invoiceId ||
    installment.status !== 'failed' ||
    installment.autopay
  )
    throw new Error(
      'Late fee requires a final failed installment on this invoice',
    );
  const lineId = newId();
  const inserted = await sql<{ id: string }>`
    INSERT INTO invoice_lines
      (id, org_id, invoice_id, kind, description, quantity,
       unit_amount_cents, amount_cents, refundable, late_fee_installment_id)
    VALUES
      (${lineId}::uuid, ${context.orgId}::uuid, ${input.invoiceId}::uuid,
       'late_fee', 'Late installment payment fee', 1,
       ${amountCents}, ${amountCents}, false, ${input.installmentId}::uuid)
    ON CONFLICT (org_id, late_fee_installment_id)
      WHERE late_fee_installment_id IS NOT NULL DO NOTHING
    RETURNING id
  `.execute(trx);
  if (!inserted.rows[0]) return false;
  await trx
    .updateTable('invoices')
    .set({
      subtotal_cents: sql`subtotal_cents + ${amountCents}`,
      total_cents: sql`total_cents + ${amountCents}`,
      version: sql`version + 1`,
    })
    .where('org_id', '=', context.orgId)
    .where('id', '=', input.invoiceId)
    .execute();
  await appendAuditEvent(trx, context, {
    action: 'installment.late_fee_applied',
    entityType: 'installment',
    entityId: input.installmentId,
    changes: {
      amountCents: { tier: 'internal', after: amountCents },
      invoiceId: { tier: 'internal', after: input.invoiceId },
    },
  });
  return true;
}
