import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

import {
  StripeRefundService,
  refundProposal,
  type RefundAttemptStore,
  type RefundResult,
  type RefundRecordStore,
  type RefundSource,
} from './refunds.js';

const source: RefundSource = {
  orgId: 'org_1',
  paymentId: 'payment_1',
  paymentIntentId: 'pi_1',
  paymentStatus: 'succeeded',
  method: 'card',
  lines: [{ id: 'line_1', paidCents: 10_000 }],
  paidServiceFeeCents: 300,
  previouslyRefundedServiceFeeCents: 0,
  policy: {
    rules: [{ throughDate: '2026-10-01', refundBps: 5_000 }],
    afterLastBps: 0,
    serviceFeeRefund: 'proportional',
  },
  approvalThresholdCents: 5_000,
  refundApplicationFee: true,
};

class AttemptStore implements RefundAttemptStore {
  readonly records = new Map<
    string,
    { hash: string; externalStarted?: boolean; result?: RefundResult }
  >();
  reserve({ key, requestHash }: { key: string; requestHash: string }) {
    const previous = this.records.get(key);
    if (previous?.hash !== undefined && previous.hash !== requestHash) {
      return Promise.resolve({ kind: 'conflict' as const });
    }
    if (previous?.result)
      return Promise.resolve({
        kind: 'replay' as const,
        result: previous.result,
      });
    if (previous) return Promise.resolve({ kind: 'busy' as const });
    this.records.set(key, { hash: requestHash });
    return Promise.resolve({ kind: 'reserved' as const });
  }
  beginExternal({ key }: { key: string }) {
    const record = this.records.get(key);
    if (!record) throw new Error('Missing reservation');
    record.externalStarted = true;
    return Promise.resolve();
  }
  complete({ key, result }: { key: string; result: RefundResult }) {
    const record = this.records.get(key);
    if (!record) throw new Error('Missing reservation');
    record.result = result;
    return Promise.resolve();
  }
  fail({ key }: { key: string }) {
    if (this.records.get(key)?.externalStarted) {
      throw new Error('External attempt cannot be released');
    }
    this.records.delete(key);
    return Promise.resolve();
  }
}

function fixture() {
  const current: RefundSource = { ...source, lines: [...source.lines] };
  const load = vi.fn().mockImplementation(() => Promise.resolve(current));
  const isAuthorizedSecondApprover = vi.fn().mockResolvedValue(true);
  const createRefund = vi
    .fn<PaymentsGateway['createRefund']>()
    .mockResolvedValue({
      id: 're_1',
      status: 'pending',
      amountCents: 5150,
    });
  const attempts = new AttemptStore();
  const records = {
    recordPending: vi.fn<RefundRecordStore['recordPending']>(() =>
      Promise.resolve(),
    ),
  };
  const service = new StripeRefundService(
    { load },
    { isAuthorizedSecondApprover },
    attempts,
    { createRefund },
    records,
  );
  const input = {
    orgId: 'org_1',
    paymentId: 'payment_1',
    cancellationDate: '2026-09-30',
    requestedByAccountId: 'staff_1',
    approvedByAccountId: 'staff_2',
    idempotencyKey: randomUUID(),
  };
  return {
    current,
    load,
    isAuthorizedSecondApprover,
    createRefund,
    attempts,
    records,
    service,
    input,
  };
}

describe('refund policy application', () => {
  it('refunds line and service fee proportionally using Track B policy', () => {
    expect(refundProposal(source, '2026-09-30')).toEqual({
      lines: [{ lineId: 'line_1', amountCents: 5_000 }],
      serviceFeeCents: 150,
      totalCents: 5_150,
      refundBps: 5_000,
    });
  });

  it('requires a separate authorized approver above the threshold', async () => {
    const test = fixture();
    await expect(
      test.service.refund({ ...test.input, approvedByAccountId: 'staff_1' }),
    ).rejects.toThrow('separate finance approver');
    expect(test.createRefund).not.toHaveBeenCalled();
    expect(test.attempts.records.size).toBe(0);
  });

  it('creates one destination refund and replays after source balances change', async () => {
    const test = fixture();
    const first = await test.service.refund(test.input);
    test.current.lines = [
      { id: 'line_1', paidCents: 10_000, previouslyRefundedCents: 5_000 },
    ];
    test.current.previouslyRefundedServiceFeeCents = 150;
    expect(await test.service.refund(test.input)).toEqual(first);
    expect(test.createRefund).toHaveBeenCalledTimes(1);
    expect(test.records.recordPending).toHaveBeenCalledTimes(1);
    expect(test.createRefund.mock.calls[0]?.[0]).toEqual({
      orgId: 'org_1',
      paymentIntentId: 'pi_1',
      amountCents: 5_150,
      reverseTransfer: true,
      refundApplicationFee: true,
      idempotencyKey: `refund:payment_1:${test.input.idempotencyKey}`,
    });
  });

  it('blocks ACH refunds while the payment is processing', async () => {
    const test = fixture();
    test.current.paymentStatus = 'processing';
    test.current.method = 'us_bank_account';
    await expect(test.service.refund(test.input)).rejects.toThrow(
      'Only succeeded payments',
    );
    expect(test.createRefund).not.toHaveBeenCalled();
  });

  it('rejects a changed request under the same idempotency key', async () => {
    const test = fixture();
    await test.service.refund(test.input);
    await expect(
      test.service.refund({ ...test.input, cancellationDate: '2026-10-02' }),
    ).rejects.toThrow('different refund');
    expect(test.createRefund).toHaveBeenCalledTimes(1);
  });

  it('keeps the key fenced when Stripe may have created a refund', async () => {
    const test = fixture();
    test.createRefund.mockRejectedValueOnce(new Error('network lost'));
    await expect(test.service.refund(test.input)).rejects.toThrow(
      'network lost',
    );
    expect(
      test.attempts.records.get(test.input.idempotencyKey)?.externalStarted,
    ).toBe(true);
    await expect(test.service.refund(test.input)).rejects.toThrow(
      'already in progress',
    );
    expect(test.createRefund).toHaveBeenCalledTimes(1);
  });

  it('keeps the key fenced when recording a created refund fails', async () => {
    const test = fixture();
    vi.spyOn(test.attempts, 'complete').mockRejectedValueOnce(
      new Error('database lost'),
    );
    await expect(test.service.refund(test.input)).rejects.toThrow(
      'database lost',
    );
    await expect(test.service.refund(test.input)).rejects.toThrow(
      'already in progress',
    );
    expect(test.createRefund).toHaveBeenCalledTimes(1);
  });

  it('fences a Stripe refund whose amount differs from the approved proposal', async () => {
    const test = fixture();
    test.createRefund.mockResolvedValueOnce({
      id: 're_wrong',
      status: 'pending',
      amountCents: 5151,
    });
    await expect(test.service.refund(test.input)).rejects.toThrow(
      'differs from the approved proposal',
    );
    expect(test.records.recordPending).not.toHaveBeenCalled();
    await expect(test.service.refund(test.input)).rejects.toThrow(
      'already in progress',
    );
  });
});
