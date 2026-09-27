import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';

import type {
  PayerProfileRepository,
  PayerReservation,
} from './payer-methods.js';

/** payer_profiles is global and keyed by the authenticated account. */
export class PostgresPayerProfileRepository implements PayerProfileRepository {
  constructor(private readonly database: Kysely<DB>) {}

  async reserve(accountId: string): Promise<PayerReservation> {
    const inserted = await sql<{ id: string }>`
      INSERT INTO payer_profiles (id, account_id, stripe_customer_id, customer_claimed_at)
      VALUES (${newId()}, ${accountId}::uuid, NULL, now())
      ON CONFLICT (account_id) DO NOTHING
      RETURNING id
    `.execute(this.database);
    if (inserted.rows.length) return { kind: 'reserved' };
    const existing = await sql<{ stripe_customer_id: string | null }>`
      SELECT stripe_customer_id FROM payer_profiles
      WHERE account_id = ${accountId}::uuid
    `.execute(this.database);
    const row = existing.rows[0];
    if (!row) throw new Error('Payer profile reservation disappeared');
    return row.stripe_customer_id
      ? { kind: 'existing', customerId: row.stripe_customer_id }
      : { kind: 'busy' };
  }

  async save(accountId: string, customerId: string): Promise<void> {
    const updated = await sql<{ id: string }>`
      UPDATE payer_profiles
      SET stripe_customer_id = ${customerId}, customer_claimed_at = NULL
      WHERE account_id = ${accountId}::uuid
        AND stripe_customer_id IS NULL
      RETURNING id
    `.execute(this.database);
    if (!updated.rows.length) {
      throw new Error('Payer profile reservation is missing or completed');
    }
  }

  async load(accountId: string): Promise<string | null> {
    const result = await sql<{ stripe_customer_id: string | null }>`
      SELECT stripe_customer_id FROM payer_profiles
      WHERE account_id = ${accountId}::uuid
    `.execute(this.database);
    return result.rows[0]?.stripe_customer_id ?? null;
  }
}
