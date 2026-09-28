import type { ProposedRefund } from '@shared/policies/refund-policy';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import {
  PostgresRefundApprovalPolicy,
  refundApprovalHash,
} from '../finance/refund-approval-repo.js';
import { PostgresRefundAttemptStore } from '../finance/refund-attempt-repo.js';
import { PostgresRefundRecordStore } from '../finance/refund-record-repo.js';
import { PostgresRefundSourceReader } from '../finance/refund-source-repo.js';
import {
  exactLineRefundProposal,
  RefundApprovalRequiredError,
  RefundConflictError,
  StripeRefundService,
} from '../finance/refunds.js';

export interface RegistrationTransferRefundInput {
  orgId: string;
  invoiceLineId: string;
  amountCents: number;
  cancellationDate: string;
  requestedByAccountId: string;
  idempotencyKey: string;
}

export interface RegistrationTransferRefundResult {
  refundId: string;
  refundIds?: string[];
  status: string;
  amountCents: number;
}

interface TransferPaymentCandidate {
  payment_id: string;
  allocated_cents: number;
  refunded_cents: number;
  attempt_status: string | null;
  attempt_result: unknown;
}

const attemptResultSchema = z.strictObject({
  id: z.string().startsWith('re_'),
  status: z.string().min(1),
  proposal: z.strictObject({
    lines: z.array(
      z.strictObject({ lineId: z.uuid(), amountCents: z.number().int() }),
    ),
    serviceFeeCents: z.number().int().nonnegative(),
    totalCents: z.number().int().positive(),
    refundBps: z.number().int().min(0).max(10_000),
  }),
});

export interface RegistrationTransferRefunds {
  refundExactLine(
    input: RegistrationTransferRefundInput,
  ): Promise<RegistrationTransferRefundResult>;
}

/** Sends a transfer price difference through the durable finance refund path. */
export class PostgresRegistrationTransferRefunds implements RegistrationTransferRefunds {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  private readonly approvals: PostgresRefundApprovalPolicy;
  private readonly reader: PostgresRefundSourceReader;
  private readonly attempts: PostgresRefundAttemptStore;
  private readonly records: PostgresRefundRecordStore;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly gateway: Pick<PaymentsGateway, 'createRefund'>,
  ) {
    this.withOrg = createWithOrg(database);
    this.approvals = new PostgresRefundApprovalPolicy(database);
    this.reader = new PostgresRefundSourceReader(database, context);
    this.attempts = new PostgresRefundAttemptStore(database, context);
    this.records = new PostgresRefundRecordStore(database, context);
  }

  async refundExactLine(
    input: RegistrationTransferRefundInput,
  ): Promise<RegistrationTransferRefundResult> {
    if (input.orgId !== this.context.orgId)
      throw new Error('Registration transfer refund organization mismatch');
    const candidates = await this.withOrg(this.context, async (trx) => {
      const result = await sql<TransferPaymentCandidate>`
        SELECT allocation.payment_id, allocation.amount_cents AS allocated_cents,
          coalesce(refunded.cents, 0)::bigint AS refunded_cents,
          attempt.status AS attempt_status, attempt.result AS attempt_result
        FROM payment_line_allocations allocation
        JOIN payments payment
          ON payment.org_id = allocation.org_id
           AND payment.id = allocation.payment_id
        LEFT JOIN refund_attempts attempt
          ON attempt.org_id = allocation.org_id
         AND attempt.payment_id = allocation.payment_id
         AND attempt.idempotency_key = ${input.idempotencyKey}::uuid
        LEFT JOIN LATERAL (
          SELECT coalesce(sum(refund_allocation.amount_cents), 0)::bigint AS cents
          FROM refund_allocations refund_allocation
          JOIN refunds refund
            ON refund.org_id = refund_allocation.org_id
           AND refund.id = refund_allocation.refund_id
          WHERE refund_allocation.org_id = allocation.org_id
            AND refund_allocation.invoice_line_id = allocation.invoice_line_id
            AND refund.payment_id = allocation.payment_id
            AND refund.status IN ('pending', 'succeeded')
            AND (attempt.result IS NULL OR
              refund.stripe_refund_id IS DISTINCT FROM attempt.result->>'id')
        ) refunded ON true
        WHERE allocation.org_id = ${input.orgId}::uuid
          AND allocation.invoice_line_id = ${input.invoiceLineId}::uuid
          AND payment.status = 'succeeded'
        ORDER BY payment.created_at, payment.id
      `.execute(trx);
      return result.rows;
    });
    if (!candidates.length)
      throw new RefundConflictError(
        'No successful payment funds this registration line',
      );
    if (
      candidates.some(
        (candidate) => candidate.attempt_status === 'external_started',
      )
    )
      throw new RefundConflictError(
        'A transfer refund has an unresolved Stripe result and requires reconciliation',
      );

    const remainingRequested = { cents: input.amountCents };
    const plan = [] as {
      paymentId: string;
      amountCents: number;
      prior: z.output<typeof attemptResultSchema> | null;
    }[];
    for (const candidate of candidates) {
      if (
        !Number.isSafeInteger(candidate.allocated_cents) ||
        !Number.isSafeInteger(candidate.refunded_cents) ||
        candidate.allocated_cents < 1 ||
        candidate.refunded_cents < 0 ||
        candidate.refunded_cents > candidate.allocated_cents
      )
        throw new RefundConflictError(
          'Payment line allocations do not reconcile for transfer refund',
        );
      const prior =
        candidate.attempt_status === 'completed'
          ? attemptResultSchema.parse(candidate.attempt_result)
          : null;
      const available = candidate.allocated_cents - candidate.refunded_cents;
      const amountCents = Math.min(available, remainingRequested.cents);
      if (prior) {
        const priorLine = prior.proposal.lines.find(
          (line) => line.lineId === input.invoiceLineId,
        );
        if (!priorLine || priorLine.amountCents !== amountCents)
          throw new RefundConflictError(
            'Transfer refund replay no longer matches its recorded line allocation',
          );
      }
      if (amountCents > 0) {
        plan.push({
          paymentId: candidate.payment_id,
          amountCents,
          prior,
        });
        remainingRequested.cents -= amountCents;
      } else if (prior) {
        throw new RefundConflictError(
          'Transfer refund replay no longer matches its recorded allocation',
        );
      }
      if (remainingRequested.cents === 0) break;
    }
    if (remainingRequested.cents !== 0)
      throw new RefundConflictError(
        'Successful payments do not fund the requested registration line cents',
      );

    const prepared = [] as {
      paymentId: string;
      amountCents: number;
      prior: z.output<typeof attemptResultSchema> | null;
      approvalThresholdCents: number;
      totalCents: number;
      proposal: ProposedRefund;
    }[];
    for (const item of plan) {
      const source = await this.reader.load(input.orgId, item.paymentId);
      if (!source)
        throw new RefundConflictError('Transfer refund payment is unavailable');
      if (item.prior) {
        prepared.push({
          ...item,
          approvalThresholdCents: source.approvalThresholdCents,
          totalCents: item.prior.proposal.totalCents,
          proposal: item.prior.proposal,
        });
        continue;
      }
      const proposal = exactLineRefundProposal(
        source,
        input.invoiceLineId,
        item.amountCents,
      );
      prepared.push({
        ...item,
        approvalThresholdCents: source.approvalThresholdCents,
        totalCents: proposal.totalCents,
        proposal,
      });
    }
    let approvedByAccountId: string | null = null;
    if (prepared.length > 1) {
      const aggregateCents = prepared.reduce(
        (sum, item) => sum + BigInt(item.totalCents),
        0n,
      );
      const threshold = Math.min(
        ...prepared.map((item) => item.approvalThresholdCents),
      );
      if (!Number.isSafeInteger(threshold) || threshold < 0)
        throw new RefundConflictError(
          'Transfer refund approval threshold is invalid',
        );
      if (aggregateCents > BigInt(Number.MAX_SAFE_INTEGER))
        throw new RefundConflictError(
          'Transfer refund total exceeds safe cents',
        );
      const approval = await this.approvals.requestTransferAggregate(
        {
          orgId: input.orgId,
          operationKey: input.idempotencyKey,
          invoiceLineId: input.invoiceLineId,
          requestedAmountCents: input.amountCents,
          cancellationDate: input.cancellationDate,
          requestedByAccountId: input.requestedByAccountId,
          totalCents: Number(aggregateCents),
          shares: prepared.map((item) => ({
            paymentId: item.paymentId,
            amountCents: item.amountCents,
            approvalThresholdCents: item.approvalThresholdCents,
            proposal: item.proposal,
            requestHash: refundApprovalHash({
              orgId: input.orgId,
              paymentId: item.paymentId,
              operationKey: input.idempotencyKey,
              destination: 'original_method',
              recipient: null,
              cancellationDate: input.cancellationDate,
              requestedByAccountId: input.requestedByAccountId,
              proposal: item.proposal,
            }),
          })),
        },
        aggregateCents > BigInt(threshold),
      );
      if (approval?.status === 'pending')
        throw new RefundApprovalRequiredError(approval.id);
      if (approval?.status === 'rejected')
        throw new RefundConflictError('Transfer refund approval was rejected');
      approvedByAccountId = approval?.approvedByAccountId ?? null;
    } else {
      const scope = await this.approvals.approvalScopeByKey(
        input.orgId,
        input.idempotencyKey,
        input.requestedByAccountId,
      );
      if (scope === 'transfer_aggregate')
        throw new RefundConflictError(
          'Transfer refund no longer matches its aggregate approval',
        );
      approvedByAccountId = await this.approvals.approvedByKey(
        input.orgId,
        input.idempotencyKey,
        input.requestedByAccountId,
      );
    }

    const refunds = new StripeRefundService(
      this.reader,
      this.approvals,
      this.attempts,
      this.gateway,
      this.records,
    );
    const results = [] as Awaited<ReturnType<typeof refunds.refundExactLine>>[];
    for (const item of prepared) {
      results.push(
        await refunds.refundExactLine({
          orgId: input.orgId,
          paymentId: item.paymentId,
          invoiceLineId: input.invoiceLineId,
          amountCents: item.amountCents,
          cancellationDate: input.cancellationDate,
          requestedByAccountId: input.requestedByAccountId,
          ...(approvedByAccountId ? { approvedByAccountId } : {}),
          idempotencyKey: input.idempotencyKey,
        }),
      );
    }
    const refundIds = results.map((result) => result.id);
    const amountCents = results.reduce(
      (sum, result) => sum + BigInt(result.proposal.totalCents),
      0n,
    );
    if (amountCents > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RefundConflictError('Transfer refund total exceeds safe cents');
    const statuses = [...new Set(results.map((result) => result.status))];
    return {
      refundId: refundIds[0] ?? '',
      ...(refundIds.length > 1 ? { refundIds } : {}),
      status: statuses.length === 1 ? (statuses[0] ?? 'pending') : 'mixed',
      amountCents: Number(amountCents),
    };
  }
}
