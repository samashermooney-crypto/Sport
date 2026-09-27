import { createHash } from 'node:crypto';

import { allocate } from '@shared/money';
import {
  proposeRefund,
  type ProposedRefund,
  type RefundableLine,
  type RefundPolicy,
} from '@shared/policies/refund-policy';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

import type { RefundApprovalInput } from './refund-approval-repo.js';

export interface RefundSource {
  orgId: string;
  paymentId: string;
  paymentIntentId: string;
  paymentStatus: 'succeeded' | 'processing' | 'failed';
  method: 'card' | 'us_bank_account' | 'link' | 'apple_pay' | 'google_pay';
  lines: readonly RefundableLine[];
  paidServiceFeeCents: number;
  previouslyRefundedServiceFeeCents: number;
  policy: RefundPolicy;
  approvalThresholdCents: number;
  refundApplicationFee: boolean;
}

export class RefundConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundConflictError';
  }
}

export interface RefundSourceReader {
  /** Must load the payment and its invoice-line allocations inside withOrg. */
  load(orgId: string, paymentId: string): Promise<RefundSource | null>;
}

export interface RefundApprovalPolicy {
  isAuthorizedSecondApprover(
    orgId: string,
    accountId: string,
    input: RefundApprovalInput,
  ): Promise<boolean>;
}

export interface RefundResult {
  id: string;
  status: string;
  proposal: ProposedRefund;
}

export type RefundReservation =
  | { kind: 'reserved' }
  | { kind: 'replay'; result: RefundResult }
  | { kind: 'busy' }
  | { kind: 'conflict' };

/** Reserve and complete are atomic org-scoped writes with an audit entry. */
export interface RefundAttemptStore {
  reserve(input: {
    orgId: string;
    paymentId: string;
    key: string;
    requestHash: string;
  }): Promise<RefundReservation>;
  /** Durable fence: after this commits, the key stays blocked until reconciled. */
  beginExternal(input: {
    orgId: string;
    paymentId: string;
    key: string;
  }): Promise<void>;
  complete(input: {
    orgId: string;
    paymentId: string;
    key: string;
    result: RefundResult;
  }): Promise<void>;
  fail(input: { orgId: string; paymentId: string; key: string }): Promise<void>;
}

/** Persists a Stripe refund and line allocations before the attempt completes. */
export interface RefundRecordStore {
  recordPending(input: {
    orgId: string;
    paymentId: string;
    refundId: string;
    proposal: ProposedRefund;
    requestedByAccountId: string;
    approvedByAccountId: string | null;
    refundApplicationFee: boolean;
    reason?: RefundReason;
    note?: string | null;
  }): Promise<void>;
}

export type RefundReason =
  | 'requested_by_customer'
  | 'duplicate'
  | 'fraudulent'
  | 'program_canceled'
  | 'withdrawal_policy'
  | 'other';

export interface RefundRequest {
  orgId: string;
  paymentId: string;
  cancellationDate: string;
  requestedByAccountId: string;
  approvedByAccountId?: string;
  idempotencyKey: string;
}

export interface ExactLineRefundRequest {
  orgId: string;
  paymentId: string;
  invoiceLineId: string;
  amountCents: number;
  cancellationDate: string;
  requestedByAccountId: string;
  approvedByAccountId?: string;
  idempotencyKey: string;
}

export function refundProposal(
  source: RefundSource,
  cancellationDate: string,
): ProposedRefund {
  if (source.paymentStatus !== 'succeeded') {
    throw new RefundConflictError('Only succeeded payments may be refunded');
  }
  return proposeRefund(
    source.lines,
    source.paidServiceFeeCents,
    cancellationDate,
    source.policy,
    source.previouslyRefundedServiceFeeCents,
  );
}

function hashRequest(input: RefundRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        orgId: input.orgId,
        paymentId: input.paymentId,
        cancellationDate: input.cancellationDate,
        requestedByAccountId: input.requestedByAccountId,
      }),
    )
    .digest('hex');
}

function hashExactLineRequest(input: ExactLineRefundRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'exact_line',
        orgId: input.orgId,
        paymentId: input.paymentId,
        invoiceLineId: input.invoiceLineId,
        amountCents: input.amountCents,
        cancellationDate: input.cancellationDate,
        requestedByAccountId: input.requestedByAccountId,
      }),
    )
    .digest('hex');
}

export function exactLineRefundProposal(
  source: RefundSource,
  invoiceLineId: string,
  amountCents: number,
): ProposedRefund {
  if (source.paymentStatus !== 'succeeded') {
    throw new RefundConflictError('Only succeeded payments may be refunded');
  }
  if (!Number.isSafeInteger(amountCents) || amountCents < 1)
    throw new RefundConflictError('Refund amount must be positive cents');
  const line = source.lines.find((candidate) => candidate.id === invoiceLineId);
  if (!line)
    throw new RefundConflictError('Refund line is not funded by this payment');
  const remainingLineCents =
    line.paidCents - (line.previouslyRefundedCents ?? 0);
  if (amountCents > remainingLineCents)
    throw new RefundConflictError(
      "Refund exceeds the line's remaining paid amount",
    );

  const paidLinesCents = source.lines.reduce(
    (sum, candidate) => sum + candidate.paidCents,
    0,
  );
  const previouslyRefundedCents = source.lines.reduce(
    (sum, candidate) => sum + (candidate.previouslyRefundedCents ?? 0),
    0,
  );
  const cumulativeRefundedCents = previouslyRefundedCents + amountCents;
  if (cumulativeRefundedCents > paidLinesCents)
    throw new RefundConflictError(
      "Refund exceeds this payment's refundable lines",
    );
  const feeTargetCents =
    source.policy.serviceFeeRefund === 'none' || paidLinesCents === 0
      ? 0
      : (allocate(source.paidServiceFeeCents, [
          cumulativeRefundedCents,
          paidLinesCents - cumulativeRefundedCents,
        ])[0] ?? 0);
  const serviceFeeCents = Math.max(
    0,
    feeTargetCents - source.previouslyRefundedServiceFeeCents,
  );
  return {
    lines: [{ lineId: invoiceLineId, amountCents }],
    serviceFeeCents,
    totalCents: amountCents + serviceFeeCents,
    refundBps: 10_000,
  };
}

export class StripeRefundService {
  constructor(
    private readonly reader: RefundSourceReader,
    private readonly approvals: RefundApprovalPolicy,
    private readonly attempts: RefundAttemptStore,
    private readonly gateway: Pick<PaymentsGateway, 'createRefund'>,
    private readonly records: RefundRecordStore,
  ) {}

  async refund(input: RefundRequest): Promise<RefundResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.idempotencyKey,
      )
    ) {
      throw new Error('Idempotency-Key must be a UUID');
    }
    return this.execute(
      input,
      hashRequest(input),
      input.cancellationDate,
      (source) => refundProposal(source, input.cancellationDate),
      'withdrawal_policy',
      null,
    );
  }

  /** Refund an exact invoice-line amount through the shared refund ledger. */
  async refundExactLine(input: ExactLineRefundRequest): Promise<RefundResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.idempotencyKey,
      )
    ) {
      throw new Error('Idempotency-Key must be a UUID');
    }
    return this.execute(
      input,
      hashExactLineRequest(input),
      input.cancellationDate,
      (source) =>
        exactLineRefundProposal(source, input.invoiceLineId, input.amountCents),
      'other',
      'Registration transfer price difference',
    );
  }

  private async execute(
    input: {
      orgId: string;
      paymentId: string;
      requestedByAccountId: string;
      approvedByAccountId?: string;
      idempotencyKey: string;
    },
    requestHash: string,
    cancellationDate: string,
    createProposal: (source: RefundSource) => ProposedRefund,
    reason: RefundReason,
    note: string | null,
  ): Promise<RefundResult> {
    const reservation = await this.attempts.reserve({
      orgId: input.orgId,
      paymentId: input.paymentId,
      key: input.idempotencyKey,
      requestHash,
    });
    if (reservation.kind === 'replay') return reservation.result;
    if (reservation.kind === 'busy')
      throw new RefundConflictError('Refund attempt is already in progress');
    if (reservation.kind === 'conflict')
      throw new RefundConflictError(
        'Idempotency-Key was used for a different refund',
      );
    let externalStarted = false;
    try {
      const source = await this.reader.load(input.orgId, input.paymentId);
      if (
        !source ||
        source.orgId !== input.orgId ||
        source.paymentId !== input.paymentId
      ) {
        throw new RefundConflictError('Payment not found');
      }
      const proposal = createProposal(source);
      if (proposal.totalCents < 1)
        throw new RefundConflictError('No refundable amount remains');
      if (proposal.totalCents > source.approvalThresholdCents) {
        if (
          !input.approvedByAccountId ||
          input.approvedByAccountId === input.requestedByAccountId ||
          !(await this.approvals.isAuthorizedSecondApprover(
            input.orgId,
            input.approvedByAccountId,
            {
              orgId: input.orgId,
              paymentId: input.paymentId,
              operationKey: input.idempotencyKey,
              destination: 'original_method',
              recipient: null,
              cancellationDate,
              requestedByAccountId: input.requestedByAccountId,
              proposal,
            },
          ))
        ) {
          throw new RefundConflictError(
            'A separate finance approver is required',
          );
        }
      }
      await this.attempts.beginExternal({
        orgId: input.orgId,
        paymentId: input.paymentId,
        key: input.idempotencyKey,
      });
      externalStarted = true;
      const refund = await this.gateway.createRefund({
        orgId: input.orgId,
        paymentIntentId: source.paymentIntentId,
        amountCents: proposal.totalCents,
        reverseTransfer: true,
        refundApplicationFee: source.refundApplicationFee,
        idempotencyKey: `refund:${input.paymentId}:${input.idempotencyKey}`,
      });
      if (
        !refund.id.startsWith('re_') ||
        refund.amountCents !== proposal.totalCents
      )
        throw new Error('Stripe refund differs from the approved proposal');
      const result = { id: refund.id, status: refund.status, proposal };
      await this.records.recordPending({
        orgId: input.orgId,
        paymentId: input.paymentId,
        refundId: refund.id,
        proposal,
        requestedByAccountId: input.requestedByAccountId,
        approvedByAccountId: input.approvedByAccountId ?? null,
        refundApplicationFee: source.refundApplicationFee,
        reason,
        note,
      });
      await this.attempts.complete({
        orgId: input.orgId,
        paymentId: input.paymentId,
        key: input.idempotencyKey,
        result,
      });
      return result;
    } catch (error) {
      if (!externalStarted) {
        await this.attempts.fail({
          orgId: input.orgId,
          paymentId: input.paymentId,
          key: input.idempotencyKey,
        });
      }
      throw error;
    }
  }
}
