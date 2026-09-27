import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import {
  type RefundAttemptStore,
  type RefundReservation,
  type RefundResult,
} from './refunds.js';

const resultSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  proposal: z.object({
    lines: z.array(
      z.object({
        lineId: z.string().min(1),
        amountCents: z.number().int().nonnegative(),
      }),
    ),
    serviceFeeCents: z.number().int().nonnegative(),
    totalCents: z.number().int().positive(),
    refundBps: z.number().int().min(0).max(10_000),
  }),
});

interface AttemptRow {
  request_hash: string;
  status: string;
  result: unknown;
}

/** Durable refund requests; every tenant query runs in withOrg. */
export class PostgresRefundAttemptStore implements RefundAttemptStore {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  private assertOrg(orgId: string): void {
    if (orgId !== this.context.orgId) {
      throw new Error('Refund attempt organization mismatch');
    }
  }

  async reserve(input: {
    orgId: string;
    paymentId: string;
    key: string;
    requestHash: string;
  }): Promise<RefundReservation> {
    this.assertOrg(input.orgId);
    return this.withOrg(this.context, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('id', '=', input.paymentId)
        .forUpdate()
        .executeTakeFirst();
      if (!payment)
        throw new Error('Refund payment does not belong to organization');
      const prior = await sql<AttemptRow & { idempotency_key: string }>`
        SELECT idempotency_key, request_hash, status, result
        FROM refund_attempts WHERE org_id = ${input.orgId}::uuid
          AND payment_id = ${input.paymentId}::uuid
          AND idempotency_key = ${input.key}::uuid
        FOR UPDATE
      `.execute(trx);
      const original = prior.rows[0];
      if (
        original?.request_hash !== undefined &&
        original.request_hash !== input.requestHash
      )
        return { kind: 'conflict' };
      if (original?.status === 'completed')
        return { kind: 'replay', result: resultSchema.parse(original.result) };
      if (
        original?.status === 'reserved' ||
        original?.status === 'external_started'
      )
        return { kind: 'busy' };
      const active = await sql<{ id: string }>`
        SELECT id FROM refund_attempts
        WHERE org_id = ${input.orgId}::uuid
          AND payment_id = ${input.paymentId}::uuid
          AND status IN ('reserved', 'external_started')
        LIMIT 1
      `.execute(trx);
      if (active.rows.length) return { kind: 'busy' };
      if (original?.status === 'failed_pre_external') {
        await sql`
          UPDATE refund_attempts SET status = 'reserved', version = version + 1
          WHERE org_id = ${input.orgId}::uuid
            AND payment_id = ${input.paymentId}::uuid
            AND idempotency_key = ${input.key}::uuid
        `.execute(trx);
        return { kind: 'reserved' };
      }
      const inserted = await sql<{ id: string }>`
        INSERT INTO refund_attempts
          (id, org_id, payment_id, idempotency_key, request_hash, status)
        VALUES
          (${newId()}, ${input.orgId}::uuid, ${input.paymentId}::uuid,
           ${input.key}::uuid, ${input.requestHash}, 'reserved')
        ON CONFLICT (org_id, payment_id, idempotency_key) DO NOTHING
        RETURNING id
      `.execute(trx);
      if (inserted.rows.length) return { kind: 'reserved' };
      throw new Error('Refund attempt reservation disappeared');
    });
  }

  async beginExternal(input: {
    orgId: string;
    paymentId: string;
    key: string;
  }): Promise<void> {
    await this.transition(input, 'reserved', 'external_started');
  }

  async complete(input: {
    orgId: string;
    paymentId: string;
    key: string;
    result: RefundResult;
  }): Promise<void> {
    this.assertOrg(input.orgId);
    const result = resultSchema.parse(input.result);
    await this.withOrg(this.context, async (trx) => {
      const updated = await sql<{ id: string }>`
        UPDATE refund_attempts
        SET status = 'completed', result = ${JSON.stringify(result)}::jsonb,
            version = version + 1
        WHERE org_id = ${input.orgId}::uuid
          AND payment_id = ${input.paymentId}::uuid
          AND idempotency_key = ${input.key}::uuid
          AND status = 'external_started'
        RETURNING id
      `.execute(trx);
      if (!updated.rows.length)
        throw new Error('Refund attempt is not externally started');
    });
  }

  async fail(input: {
    orgId: string;
    paymentId: string;
    key: string;
  }): Promise<void> {
    await this.transition(input, 'reserved', 'failed_pre_external');
  }

  private async transition(
    input: { orgId: string; paymentId: string; key: string },
    from: string,
    to: string,
  ): Promise<void> {
    this.assertOrg(input.orgId);
    await this.withOrg(this.context, async (trx) => {
      const updated = await sql<{ id: string }>`
        UPDATE refund_attempts
        SET status = ${to}, version = version + 1
        WHERE org_id = ${input.orgId}::uuid
          AND payment_id = ${input.paymentId}::uuid
          AND idempotency_key = ${input.key}::uuid
          AND status = ${from}
        RETURNING id
      `.execute(trx);
      if (!updated.rows.length) throw new Error('Refund attempt state changed');
    });
  }
}
