import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import {
  type CreatedPaymentIntent,
  type PaymentAttemptReservation,
  type PaymentAttemptStore,
} from './service.js';

const resultSchema = z.object({
  id: z.string().startsWith('pi_'),
  clientSecret: z.string().min(1),
  status: z.string().min(1),
  quote: z.object({
    baseCents: z.number().int().nonnegative(),
    serviceFeeCents: z.number().int().nonnegative(),
    taxCents: z.number().int().nonnegative(),
    amountCents: z.number().int().positive(),
    applicationFeeCents: z.number().int().nonnegative(),
  }),
});

interface AttemptRow {
  request_hash: string;
  status: string;
  result: unknown;
}

/** All payment_attempts operations are scoped by withOrg and actor context. */
export class PostgresPaymentAttemptStore implements PaymentAttemptStore {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
  ) {
    this.withOrg = createWithOrg(database);
  }

  private assertOrg(orgId: string): void {
    if (orgId !== this.context.orgId) {
      throw new Error('Payment attempt organization mismatch');
    }
  }

  async reserve(input: {
    orgId: string;
    checkoutId: string;
    key: string;
    requestHash: string;
  }): Promise<PaymentAttemptReservation> {
    this.assertOrg(input.orgId);
    return this.withOrg(this.context, async (trx) => {
      const inserted = await sql<{ id: string }>`
        INSERT INTO payment_attempts
          (id, org_id, checkout_id, idempotency_key, request_hash, status)
        VALUES
          (${newId()}, ${input.orgId}::uuid, ${input.checkoutId}::uuid,
           ${input.key}::uuid, ${input.requestHash}, 'reserved')
        ON CONFLICT (org_id, checkout_id, idempotency_key) DO NOTHING
        RETURNING id
      `.execute(trx);
      if (inserted.rows.length) return { kind: 'reserved' };
      const existing = await sql<AttemptRow>`
        SELECT request_hash, status, result FROM payment_attempts
        WHERE org_id = ${input.orgId}::uuid
          AND checkout_id = ${input.checkoutId}::uuid
          AND idempotency_key = ${input.key}::uuid
        FOR UPDATE
      `.execute(trx);
      const row = existing.rows[0];
      if (!row) throw new Error('Payment attempt reservation disappeared');
      if (row.request_hash !== input.requestHash) return { kind: 'conflict' };
      if (row.status === 'completed') {
        return { kind: 'replay', result: resultSchema.parse(row.result) };
      }
      if (row.status === 'failed_pre_external') {
        await sql`
          UPDATE payment_attempts
          SET status = 'reserved', version = version + 1
          WHERE org_id = ${input.orgId}::uuid
            AND checkout_id = ${input.checkoutId}::uuid
            AND idempotency_key = ${input.key}::uuid
        `.execute(trx);
        return { kind: 'reserved' };
      }
      return { kind: 'busy' };
    });
  }

  async beginExternal(input: {
    orgId: string;
    checkoutId: string;
    key: string;
  }): Promise<void> {
    await this.transition(input, 'reserved', 'external_started');
  }

  async complete(input: {
    orgId: string;
    checkoutId: string;
    key: string;
    result: CreatedPaymentIntent;
  }): Promise<void> {
    this.assertOrg(input.orgId);
    const result = resultSchema.parse(input.result);
    await this.withOrg(this.context, async (trx) => {
      const updated = await sql<{ id: string }>`
        UPDATE payment_attempts
        SET status = 'completed', result = ${JSON.stringify(result)}::jsonb,
            version = version + 1
        WHERE org_id = ${input.orgId}::uuid
          AND checkout_id = ${input.checkoutId}::uuid
          AND idempotency_key = ${input.key}::uuid
          AND status = 'external_started'
        RETURNING id
      `.execute(trx);
      if (!updated.rows.length)
        throw new Error('Payment attempt is not externally started');
    });
  }

  async fail(input: {
    orgId: string;
    checkoutId: string;
    key: string;
  }): Promise<void> {
    await this.transition(input, 'reserved', 'failed_pre_external');
  }

  private async transition(
    input: { orgId: string; checkoutId: string; key: string },
    from: string,
    to: string,
  ): Promise<void> {
    this.assertOrg(input.orgId);
    await this.withOrg(this.context, async (trx) => {
      const updated = await sql<{ id: string }>`
        UPDATE payment_attempts
        SET status = ${to}, version = version + 1
        WHERE org_id = ${input.orgId}::uuid
          AND checkout_id = ${input.checkoutId}::uuid
          AND idempotency_key = ${input.key}::uuid
          AND status = ${from}
        RETURNING id
      `.execute(trx);
      if (!updated.rows.length)
        throw new Error('Payment attempt state changed');
    });
  }
}
