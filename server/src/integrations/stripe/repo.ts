import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';

import {
  type ClaimedStripeEvent,
  type StoredStripeEvent,
  type StripeEventRepository,
} from './dispatch.js';
import { parseStripeWebhookEvent } from './webhooks.js';

interface EventRow {
  stripe_event_id: string;
  account: string | null;
  type: string;
  payload: unknown;
  processed_at: Date | null;
}

function storedFrom(row: EventRow, claimToken: string): ClaimedStripeEvent {
  const event = parseStripeWebhookEvent(row.payload);
  if (event.id !== row.stripe_event_id || event.type !== row.type) {
    throw new Error('Stored Stripe event is inconsistent');
  }
  if ((event.account ?? null) !== row.account) {
    throw new Error('Stored Stripe account is inconsistent');
  }
  return {
    id: event.id,
    endpoint: row.account ? 'connect' : 'platform',
    event,
    claimToken,
  };
}

/** stripe_events is a global ingress table; tenant handlers use withOrg. */
export class PostgresStripeEventRepository implements StripeEventRepository {
  constructor(private readonly database: Kysely<DB>) {}

  /** Recover stored events when the enqueue or worker process did not survive. */
  async pendingIds(limit = 100): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Stripe replay limit must be 1–100');
    const result = await sql<{ stripe_event_id: string }>`
      SELECT stripe_event_id FROM stripe_events
      WHERE processed_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY received_at, id LIMIT ${limit}
    `.execute(this.database);
    return result.rows.map((row) => row.stripe_event_id);
  }

  async store(
    stored: StoredStripeEvent,
  ): Promise<'inserted' | 'pending' | 'processed'> {
    if (
      stored.id !== stored.event.id ||
      (stored.endpoint === 'connect') !== Boolean(stored.event.account)
    ) {
      throw new Error('Stripe event endpoint mismatch');
    }
    const inserted = await sql<{ stripe_event_id: string }>`
      INSERT INTO stripe_events
        (id, stripe_event_id, account, type, payload)
      VALUES
        (${newId()}, ${stored.id}, ${stored.event.account ?? null},
         ${stored.event.type}, ${JSON.stringify(stored.event)}::jsonb)
      ON CONFLICT (stripe_event_id) DO NOTHING
      RETURNING stripe_event_id
    `.execute(this.database);
    if (inserted.rows.length) return 'inserted';
    const existing = await sql<EventRow>`
      SELECT stripe_event_id, account, type, payload, processed_at
      FROM stripe_events WHERE stripe_event_id = ${stored.id}
    `.execute(this.database);
    const row = existing.rows[0];
    if (
      !row ||
      row.type !== stored.event.type ||
      row.account !== (stored.event.account ?? null)
    ) {
      throw new Error('Conflicting Stripe event ID');
    }
    return row.processed_at ? 'processed' : 'pending';
  }

  async claim(eventId: string): Promise<ClaimedStripeEvent | null> {
    const claimToken = newId();
    const result = await sql<EventRow>`
      UPDATE stripe_events
      SET lease_token = ${claimToken},
          lease_expires_at = now() + interval '5 minutes',
          attempts = attempts + 1
      WHERE stripe_event_id = ${eventId}
        AND processed_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      RETURNING stripe_event_id, account, type, payload, processed_at
    `.execute(this.database);
    const row = result.rows[0];
    return row ? storedFrom(row, claimToken) : null;
  }

  async complete(eventId: string, claimToken: string): Promise<void> {
    const result = await sql<{ stripe_event_id: string }>`
      UPDATE stripe_events
      SET processed_at = now(), error = NULL,
          lease_token = NULL, lease_expires_at = NULL
      WHERE stripe_event_id = ${eventId}
        AND lease_token = ${claimToken}::uuid
        AND processed_at IS NULL
      RETURNING stripe_event_id
    `.execute(this.database);
    if (!result.rows.length) throw new Error('Stripe event claim is stale');
  }

  async fail(
    eventId: string,
    claimToken: string,
    message: string,
  ): Promise<void> {
    const result = await sql<{ stripe_event_id: string }>`
      UPDATE stripe_events
      SET error = ${message}, lease_token = NULL, lease_expires_at = NULL
      WHERE stripe_event_id = ${eventId}
        AND lease_token = ${claimToken}::uuid
        AND processed_at IS NULL
      RETURNING stripe_event_id
    `.execute(this.database);
    if (!result.rows.length) throw new Error('Stripe event claim is stale');
  }
}
