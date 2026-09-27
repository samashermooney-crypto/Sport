import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { PostgresRefundApprovalPolicy } from '../finance/refund-approval-repo.js';
import { PostgresRefundAttemptStore } from '../finance/refund-attempt-repo.js';
import { PostgresRefundRecordStore } from '../finance/refund-record-repo.js';
import { PostgresRefundSourceReader } from '../finance/refund-source-repo.js';
import {
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
  status: string;
  amountCents: number;
}

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
    const payment = await this.withOrg(this.context, async (trx) => {
      const result = await sql<{ payment_id: string }>`
        SELECT allocation.payment_id
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
        ) refunded ON true
        WHERE allocation.org_id = ${input.orgId}::uuid
          AND allocation.invoice_line_id = ${input.invoiceLineId}::uuid
          AND payment.status = 'succeeded'
          AND (
            allocation.amount_cents - refunded.cents >= ${input.amountCents}
            OR attempt.status IN ('completed', 'external_started')
          )
        ORDER BY (attempt.status = 'completed') DESC,
          payment.created_at DESC, payment.id
        LIMIT 1
      `.execute(trx);
      return result.rows[0]?.payment_id ?? null;
    });
    if (!payment)
      throw new RefundConflictError(
        'No single successful payment has enough remaining cents on this registration line',
      );

    const approvedByAccountId = await this.approvals.approvedByKey(
      input.orgId,
      input.idempotencyKey,
      input.requestedByAccountId,
    );
    const result = await new StripeRefundService(
      this.reader,
      this.approvals,
      this.attempts,
      this.gateway,
      this.records,
    ).refundExactLine({
      orgId: input.orgId,
      paymentId: payment,
      invoiceLineId: input.invoiceLineId,
      amountCents: input.amountCents,
      cancellationDate: input.cancellationDate,
      requestedByAccountId: input.requestedByAccountId,
      ...(approvedByAccountId ? { approvedByAccountId } : {}),
      idempotencyKey: input.idempotencyKey,
    });
    return {
      refundId: result.id,
      status: result.status,
      amountCents: result.proposal.totalCents,
    };
  }
}
