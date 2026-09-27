import { createHash } from 'node:crypto';

import {
  proposeRefund,
  type ProposedRefund,
  type RefundableLine,
  type RefundPolicy,
} from '@shared/policies/refund-policy';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

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

export interface RefundSourceReader {
  /** Must load the payment and its invoice-line allocations inside withOrg. */
  load(orgId: string, paymentId: string): Promise<RefundSource | null>;
}

export interface RefundApprovalPolicy {
  isAuthorizedSecondApprover(
    orgId: string,
    accountId: string,
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

export interface RefundRequest {
  orgId: string;
  paymentId: string;
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
    throw new Error('Only succeeded payments may be refunded');
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
        approvedByAccountId: input.approvedByAccountId ?? null,
      }),
    )
    .digest('hex');
}

export class StripeRefundService {
  constructor(
    private readonly reader: RefundSourceReader,
    private readonly approvals: RefundApprovalPolicy,
    private readonly attempts: RefundAttemptStore,
    private readonly gateway: Pick<PaymentsGateway, 'createRefund'>,
  ) {}

  async refund(input: RefundRequest): Promise<RefundResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.idempotencyKey,
      )
    ) {
      throw new Error('Idempotency-Key must be a UUID');
    }
    const reservation = await this.attempts.reserve({
      orgId: input.orgId,
      paymentId: input.paymentId,
      key: input.idempotencyKey,
      requestHash: hashRequest(input),
    });
    if (reservation.kind === 'replay') return reservation.result;
    if (reservation.kind === 'busy')
      throw new Error('Refund attempt is already in progress');
    if (reservation.kind === 'conflict')
      throw new Error('Idempotency-Key was used for a different refund');
    let externalStarted = false;
    try {
      const source = await this.reader.load(input.orgId, input.paymentId);
      if (
        !source ||
        source.orgId !== input.orgId ||
        source.paymentId !== input.paymentId
      ) {
        throw new Error('Payment not found');
      }
      const proposal = refundProposal(source, input.cancellationDate);
      if (proposal.totalCents < 1)
        throw new Error('No refundable amount remains');
      if (proposal.totalCents > source.approvalThresholdCents) {
        if (
          !input.approvedByAccountId ||
          input.approvedByAccountId === input.requestedByAccountId ||
          !(await this.approvals.isAuthorizedSecondApprover(
            input.orgId,
            input.approvedByAccountId,
          ))
        ) {
          throw new Error('A separate finance approver is required');
        }
      }
      await this.attempts.beginExternal({
        orgId: input.orgId,
        paymentId: input.paymentId,
        key: input.idempotencyKey,
      });
      externalStarted = true;
      const refund = await this.gateway.createRefund({
        paymentIntentId: source.paymentIntentId,
        amountCents: proposal.totalCents,
        reverseTransfer: true,
        refundApplicationFee: source.refundApplicationFee,
        idempotencyKey: `refund:${input.paymentId}:${input.idempotencyKey}`,
      });
      const result = { id: refund.id, status: refund.status, proposal };
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
