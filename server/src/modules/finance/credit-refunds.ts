import { createHash } from 'node:crypto';

import type { ProposedRefund } from '@shared/policies/refund-policy';

import {
  refundProposal,
  RefundConflictError,
  type RefundApprovalPolicy,
  type RefundRequest,
  type RefundSourceReader,
} from './refunds.js';

export interface CreditRefundRequest extends RefundRequest {
  recipient: 'account' | 'household';
}

export interface CreditRefundResult {
  refundId: string;
  creditId: string;
  amountCents: number;
}

export interface CreditRefundRepository {
  replay(
    input: CreditRefundRequest,
    requestHash: string,
  ): Promise<CreditRefundResult | null>;
  apply(
    input: CreditRefundRequest,
    requestHash: string,
    proposal: ProposedRefund,
  ): Promise<CreditRefundResult>;
}

function requestHash(input: CreditRefundRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        orgId: input.orgId,
        paymentId: input.paymentId,
        cancellationDate: input.cancellationDate,
        requestedByAccountId: input.requestedByAccountId,
        approvedByAccountId: input.approvedByAccountId ?? null,
        recipient: input.recipient,
      }),
    )
    .digest('hex');
}

/** Refund-to-credit changes invoice and available credit in one transaction. */
export class CreditRefundService {
  constructor(
    private readonly reader: RefundSourceReader,
    private readonly approvals: RefundApprovalPolicy,
    private readonly repository: CreditRefundRepository,
  ) {}

  async refund(input: CreditRefundRequest): Promise<CreditRefundResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.idempotencyKey,
      )
    )
      throw new Error('Idempotency-Key must be a UUID');
    const hash = requestHash(input);
    const replay = await this.repository.replay(input, hash);
    if (replay) return replay;
    const source = await this.reader.load(input.orgId, input.paymentId);
    if (
      !source ||
      source.orgId !== input.orgId ||
      source.paymentId !== input.paymentId
    )
      throw new RefundConflictError('Payment not found');
    const proposal = refundProposal(source, input.cancellationDate);
    if (proposal.totalCents < 1)
      throw new RefundConflictError('No refundable amount remains');
    if (proposal.totalCents > source.approvalThresholdCents) {
      if (
        !input.approvedByAccountId ||
        input.approvedByAccountId === input.requestedByAccountId ||
        !(await this.approvals.isAuthorizedSecondApprover(
          input.orgId,
          input.approvedByAccountId,
        ))
      )
        throw new RefundConflictError(
          'A separate finance approver is required',
        );
    }
    return this.repository.apply(input, hash, proposal);
  }
}
