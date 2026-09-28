import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import type { ProposedRefund } from '@shared/policies/refund-policy';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

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

export function refundApprovalHash(input: RefundApprovalInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export interface TransferRefundApprovalShare {
  paymentId: string;
  amountCents: number;
  approvalThresholdCents: number;
  proposal: ProposedRefund;
  requestHash: string;
}

const transferApprovalDetailsSchema = z.strictObject({
  invoiceLineId: z.uuid(),
  requestedAmountCents: z.number().int().positive(),
  cancellationDate: z.iso.date(),
  shares: z
    .array(
      z.strictObject({
        paymentId: z.uuid(),
        amountCents: z.number().int().positive(),
        approvalThresholdCents: z.number().int().nonnegative(),
        proposal: z.strictObject({
          lines: z.array(
            z.strictObject({ lineId: z.uuid(), amountCents: z.number().int() }),
          ),
          serviceFeeCents: z.number().int().nonnegative(),
          totalCents: z.number().int().positive(),
          refundBps: z.number().int().min(0).max(10_000),
        }),
        requestHash: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(2),
});

export const refundApprovalQueueSchema = z.strictObject({
  approvals: z.array(
    z.strictObject({
      id: z.uuid(),
      scope: z.enum(['payment', 'transfer_aggregate']),
      paymentId: z.uuid(),
      amountCents: z.number().int().positive(),
      requestedByAccountId: z.uuid(),
      cancellationDate: z.iso.date(),
      createdAt: z.iso.datetime(),
      transferDetails: z
        .strictObject({
          invoiceLineId: z.uuid(),
          requestedAmountCents: z.number().int().positive(),
          cancellationDate: z.iso.date(),
          shares: z.array(
            z.strictObject({
              paymentId: z.uuid(),
              amountCents: z.number().int().positive(),
              approvalThresholdCents: z.number().int().nonnegative(),
              proposal: z.strictObject({
                lines: z.array(
                  z.strictObject({
                    lineId: z.uuid(),
                    amountCents: z.number().int(),
                  }),
                ),
                serviceFeeCents: z.number().int().nonnegative(),
                totalCents: z.number().int().positive(),
                refundBps: z.number().int().min(0).max(10_000),
              }),
            }),
          ),
        })
        .nullable(),
    }),
  ),
});

export interface TransferRefundApprovalInput {
  orgId: string;
  operationKey: string;
  invoiceLineId: string;
  requestedAmountCents: number;
  cancellationDate: string;
  requestedByAccountId: string;
  totalCents: number;
  shares: readonly TransferRefundApprovalShare[];
}

interface ApprovalRow {
  id: string;
  payment_id: string;
  request_hash: string;
  requested_by: string;
  approved_by: string | null;
  status: 'pending' | 'approved' | 'rejected';
  amount_cents: number;
  approval_scope?: 'payment' | 'transfer_aggregate';
  transfer_details?: unknown;
}

/** A second authenticated finance account approves the exact proposed cents. */
export class PostgresRefundApprovalPolicy implements RefundApprovalPolicy {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(private readonly database: Kysely<DB>) {
    this.withOrg = createWithOrg(database);
  }

  async listPending(orgId: string, actorAccountId: string) {
    const context: OrgContext = {
      orgId,
      actor: { accountId: actorAccountId },
    };
    await requireFinanceStaff(this.database, context);
    return this.withOrg(context, async (trx) => {
      const result = await sql<{
        id: string;
        approval_scope: string;
        payment_id: string;
        amount_cents: number;
        requested_by: string;
        cancellation_date: string;
        created_at: Date;
        transfer_details: unknown;
      }>`
        SELECT id, approval_scope, payment_id, amount_cents, requested_by,
          to_char(cancellation_date, 'YYYY-MM-DD') AS cancellation_date,
          created_at, transfer_details
        FROM refund_approvals
        WHERE org_id = ${orgId}::uuid AND status = 'pending'
        ORDER BY created_at, id
      `.execute(trx);
      return {
        approvals: result.rows.map((row) => {
          if (
            row.approval_scope !== 'payment' &&
            row.approval_scope !== 'transfer_aggregate'
          )
            throw new RefundConflictError('Refund approval scope is invalid');
          const transferDetails =
            row.approval_scope === 'transfer_aggregate'
              ? transferApprovalDetailsSchema.parse(row.transfer_details)
              : null;
          return {
            id: row.id,
            scope: row.approval_scope,
            paymentId: row.payment_id,
            amountCents: row.amount_cents,
            requestedByAccountId: row.requested_by,
            cancellationDate: row.cancellation_date,
            createdAt: row.created_at.toISOString(),
            transferDetails: transferDetails
              ? {
                  invoiceLineId: transferDetails.invoiceLineId,
                  requestedAmountCents: transferDetails.requestedAmountCents,
                  cancellationDate: transferDetails.cancellationDate,
                  shares: transferDetails.shares.map((share) => ({
                    paymentId: share.paymentId,
                    amountCents: share.amountCents,
                    approvalThresholdCents: share.approvalThresholdCents,
                    proposal: share.proposal,
                  })),
                }
              : null,
          };
        }),
      };
    });
  }

  /** Reserve one immutable review for every payment share of a transfer refund. */
  async requestTransferAggregate(
    input: TransferRefundApprovalInput,
    required: boolean,
  ): Promise<{
    id: string;
    status: 'pending' | 'approved' | 'rejected';
    amountCents: number;
    approvedByAccountId: string | null;
  } | null> {
    if (
      !Number.isSafeInteger(input.totalCents) ||
      input.totalCents < 1 ||
      !Number.isSafeInteger(input.requestedAmountCents) ||
      input.requestedAmountCents < 1 ||
      input.shares.length < 2
    )
      throw new RangeError('Transfer refund approval amounts are invalid');
    const details = transferApprovalDetailsSchema.parse({
      invoiceLineId: input.invoiceLineId,
      requestedAmountCents: input.requestedAmountCents,
      cancellationDate: input.cancellationDate,
      shares: input.shares,
    });
    const expectedTotal = input.shares.reduce(
      (sum, share) => sum + BigInt(share.proposal.totalCents),
      0n,
    );
    if (
      expectedTotal !== BigInt(input.totalCents) ||
      input.shares.some(
        (share) =>
          !Number.isSafeInteger(share.amountCents) ||
          share.amountCents < 1 ||
          !Number.isSafeInteger(share.approvalThresholdCents) ||
          share.approvalThresholdCents < 0 ||
          share.proposal.lines.length !== 1 ||
          share.proposal.lines[0]?.lineId !== input.invoiceLineId ||
          share.proposal.lines[0].amountCents !== share.amountCents ||
          share.proposal.totalCents !==
            share.amountCents + share.proposal.serviceFeeCents,
      )
    )
      throw new RefundConflictError(
        'Transfer refund approval shares do not reconcile',
      );
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          scope: 'transfer_aggregate',
          orgId: input.orgId,
          operationKey: input.operationKey,
          cancellationDate: input.cancellationDate,
          requestedByAccountId: input.requestedByAccountId,
          totalCents: input.totalCents,
          details,
        }),
      )
      .digest('hex');
    const context: OrgContext = {
      orgId: input.orgId,
      actor: { accountId: input.requestedByAccountId },
    };
    const result = await this.withOrg(context, async (trx) => {
      const paymentIds = [
        ...new Set(input.shares.map((share) => share.paymentId)),
      ].sort();
      if (paymentIds.length !== input.shares.length)
        throw new RefundConflictError(
          'Transfer refund repeats a payment share',
        );
      const payments = await trx
        .selectFrom('payments')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('id', 'in', paymentIds)
        .orderBy('id')
        .forUpdate()
        .execute();
      if (payments.length !== paymentIds.length)
        throw new RefundConflictError('Transfer refund payment is unavailable');
      if (required)
        await sql`
          INSERT INTO refund_approvals (
            id, org_id, payment_id, operation_key, destination, recipient,
            cancellation_date, amount_cents, request_hash, requested_by,
            approval_scope, transfer_details
          )
          VALUES (${newId()}::uuid, ${input.orgId}::uuid,
            ${input.shares[0]?.paymentId}::uuid, ${input.operationKey}::uuid,
            'original_method', NULL, ${input.cancellationDate}::date,
            ${input.totalCents}, ${requestHash},
            ${input.requestedByAccountId}::uuid, 'transfer_aggregate',
            ${JSON.stringify(details)}::jsonb)
          ON CONFLICT (org_id, operation_key) DO NOTHING
        `.execute(trx);
      const rows = await sql<ApprovalRow>`
        SELECT id, payment_id, request_hash, requested_by, approved_by,
          status, amount_cents, approval_scope, transfer_details
        FROM refund_approvals
        WHERE org_id = ${input.orgId}::uuid
          AND operation_key = ${input.operationKey}::uuid
        FOR UPDATE
      `.execute(trx);
      const row = rows.rows[0];
      if (!row) return null;
      if (
        row.approval_scope !== 'transfer_aggregate' ||
        row.request_hash !== requestHash ||
        row.payment_id !== input.shares[0]?.paymentId ||
        row.requested_by !== input.requestedByAccountId ||
        row.amount_cents !== input.totalCents
      )
        throw new RefundConflictError(
          'Transfer refund approval key conflicts with another request',
        );
      transferApprovalDetailsSchema.parse(row.transfer_details);
      return {
        id: row.id,
        status: row.status,
        amountCents: row.amount_cents,
        approvedByAccountId: row.approved_by,
      };
    });
    if (result?.status === 'approved') {
      if (
        !result.approvedByAccountId ||
        result.approvedByAccountId === input.requestedByAccountId
      )
        throw new RefundConflictError('Transfer refund approval is invalid');
      await requireFinanceStaff(this.database, {
        orgId: input.orgId,
        actor: { accountId: result.approvedByAccountId },
      });
    }
    return result;
  }

  async approvalScopeByKey(
    orgId: string,
    operationKey: string,
    accountId: string,
  ): Promise<'payment' | 'transfer_aggregate' | null> {
    return this.withOrg({ orgId, actor: { accountId } }, async (trx) => {
      const row = await trx
        .selectFrom('refund_approvals')
        .select('approval_scope')
        .where('org_id', '=', orgId)
        .where('operation_key', '=', operationKey)
        .executeTakeFirst();
      if (!row) return null;
      if (
        row.approval_scope !== 'payment' &&
        row.approval_scope !== 'transfer_aggregate'
      )
        throw new RefundConflictError('Refund approval scope is invalid');
      return row.approval_scope;
    });
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
          status, amount_cents, approval_scope, transfer_details
        FROM refund_approvals
        WHERE org_id = ${orgId}::uuid
          AND operation_key = ${input.operationKey}::uuid
      `.execute(trx);
        const row = result.rows[0];
        const requestHash = refundApprovalHash(input);
        const matchesSingle =
          row?.approval_scope === 'payment' &&
          row.request_hash === requestHash &&
          row.payment_id === input.paymentId &&
          row.requested_by === input.requestedByAccountId &&
          row.amount_cents === input.proposal.totalCents;
        let matchesTransfer = false;
        if (row?.approval_scope === 'transfer_aggregate') {
          const details = transferApprovalDetailsSchema.safeParse(
            row.transfer_details,
          );
          matchesTransfer =
            details.success &&
            details.data.shares.some(
              (share) =>
                share.paymentId === input.paymentId &&
                share.requestHash === requestHash &&
                share.proposal.totalCents === input.proposal.totalCents,
            );
        }
        return (
          row?.status === 'approved' &&
          row.approved_by === accountId &&
          row.requested_by === input.requestedByAccountId &&
          (matchesSingle || matchesTransfer)
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
