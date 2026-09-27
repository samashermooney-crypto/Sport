import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import type { ProposedRefund } from '@shared/policies/refund-policy';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import { RefundConflictError, type RefundApprovalPolicy } from './refunds.js';
import { FinanceAccessError, requireFinanceStaff } from './staff-access.js';

export interface RefundApprovalInput {
  orgId: string;
  paymentId: string;
  operationKey: string;
  destination: 'original_method' | 'credit';
  recipient: 'account' | 'household' | null;
  cancellationDate: string;
  requestedByAccountId: string;
  proposal: ProposedRefund;
}

function refundApprovalHash(input: RefundApprovalInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

interface ApprovalRow {
  id: string;
  payment_id: string;
  request_hash: string;
  requested_by: string;
  approved_by: string | null;
  status: 'pending' | 'approved' | 'rejected';
  amount_cents: number;
}

/** A second authenticated finance account approves the exact proposed cents. */
export class PostgresRefundApprovalPolicy implements RefundApprovalPolicy {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(private readonly database: Kysely<DB>) {
    this.withOrg = createWithOrg(database);
  }

  async request(input: RefundApprovalInput): Promise<{
    id: string;
    status: string;
    amountCents: number;
  }> {
    if (
      !Number.isSafeInteger(input.proposal.totalCents) ||
      input.proposal.totalCents < 1
    )
      throw new RangeError('Refund approval amount must be positive cents');
    const context: OrgContext = {
      orgId: input.orgId,
      actor: { accountId: input.requestedByAccountId },
    };
    const hash = refundApprovalHash(input);
    return this.withOrg(context, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.paymentId)
        .forUpdate()
        .executeTakeFirst();
      if (!payment) throw new Error('Refund approval payment is unavailable');
      await sql`
        INSERT INTO refund_approvals (
          id, org_id, payment_id, operation_key, destination, recipient,
          cancellation_date, amount_cents, request_hash, requested_by)
        VALUES (${newId()}::uuid, ${input.orgId}::uuid,
          ${input.paymentId}::uuid, ${input.operationKey}::uuid,
          ${input.destination}, ${input.recipient}, ${input.cancellationDate}::date,
          ${input.proposal.totalCents}, ${hash}, ${input.requestedByAccountId}::uuid)
        ON CONFLICT (org_id, operation_key) DO NOTHING
      `.execute(trx);
      const result = await sql<ApprovalRow>`
        SELECT id, payment_id, request_hash, requested_by, approved_by,
          status, amount_cents FROM refund_approvals
        WHERE org_id = ${input.orgId}::uuid
          AND operation_key = ${input.operationKey}::uuid FOR UPDATE
      `.execute(trx);
      const row = result.rows[0];
      if (
        !row ||
        row.request_hash !== hash ||
        row.payment_id !== input.paymentId ||
        row.requested_by !== input.requestedByAccountId
      )
        throw new RefundConflictError(
          'Refund approval key conflicts with another request',
        );
      return { id: row.id, status: row.status, amountCents: row.amount_cents };
    });
  }

  async approve(
    orgId: string,
    approvalId: string,
    approverAccountId: string,
  ): Promise<void> {
    await requireFinanceStaff(this.database, {
      orgId,
      actor: { accountId: approverAccountId },
    });
    const context: OrgContext = {
      orgId,
      actor: { accountId: approverAccountId },
    };
    await this.withOrg(context, async (trx) => {
      const result = await sql<ApprovalRow>`
        SELECT id, payment_id, request_hash, requested_by, approved_by,
          status, amount_cents FROM refund_approvals
        WHERE org_id = ${orgId}::uuid AND id = ${approvalId}::uuid FOR UPDATE
      `.execute(trx);
      const row = result.rows[0];
      if (!row)
        throw new RefundConflictError('Refund approval request is unavailable');
      if (row.requested_by === approverAccountId)
        throw new FinanceAccessError();
      if (row.status === 'approved') {
        if (row.approved_by !== approverAccountId)
          throw new RefundConflictError(
            'Refund was approved by another finance user',
          );
        return;
      }
      if (row.status !== 'pending')
        throw new RefundConflictError('Refund approval is no longer pending');
      await sql`
        UPDATE refund_approvals SET status = 'approved',
          approved_by = ${approverAccountId}::uuid, approved_at = now(),
          version = version + 1
        WHERE org_id = ${orgId}::uuid AND id = ${approvalId}::uuid
      `.execute(trx);
      await appendAuditEvent(trx, context, {
        action: 'refund.approved',
        entityType: 'refund_approval',
        entityId: approvalId,
        changes: { amountCents: { tier: 'internal', after: row.amount_cents } },
      });
    });
  }

  async approvedByKey(
    orgId: string,
    operationKey: string,
    requesterAccountId: string,
  ): Promise<string | null> {
    return this.withOrg(
      { orgId, actor: { accountId: requesterAccountId } },
      async (trx) => {
        const result = await sql<{ approved_by: string | null }>`
        SELECT approved_by FROM refund_approvals
        WHERE org_id = ${orgId}::uuid
          AND operation_key = ${operationKey}::uuid AND status = 'approved'
      `.execute(trx);
        return result.rows[0]?.approved_by ?? null;
      },
    );
  }

  async isAuthorizedSecondApprover(
    orgId: string,
    accountId: string,
    input: RefundApprovalInput,
  ): Promise<boolean> {
    if (orgId !== input.orgId || accountId === input.requestedByAccountId)
      return false;
    const approved = await this.withOrg(
      { orgId, actor: { accountId } },
      async (trx) => {
        const result = await sql<ApprovalRow>`
        SELECT id, payment_id, request_hash, requested_by, approved_by,
          status, amount_cents FROM refund_approvals
        WHERE org_id = ${orgId}::uuid
          AND operation_key = ${input.operationKey}::uuid
      `.execute(trx);
        const row = result.rows[0];
        return (
          row?.status === 'approved' &&
          row.approved_by === accountId &&
          row.request_hash === refundApprovalHash(input) &&
          row.payment_id === input.paymentId &&
          row.requested_by === input.requestedByAccountId &&
          row.amount_cents === input.proposal.totalCents
        );
      },
    );
    if (!approved) return false;
    try {
      await requireFinanceStaff(this.database, { orgId, actor: { accountId } });
      return true;
    } catch (error) {
      if (error instanceof FinanceAccessError) return false;
      throw error;
    }
  }
}
