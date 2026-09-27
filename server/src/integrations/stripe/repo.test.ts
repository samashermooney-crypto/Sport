import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';

import { PostgresStripeEventRepository } from './repo.js';
import { stripeEventFixture } from './webhook-fixtures.js';
import { parseStripeWebhookEvent } from './webhooks.js';

let database: Kysely<DB>;
let repository: PostgresStripeEventRepository;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  repository = new PostgresStripeEventRepository(database);
});

afterAll(async () => {
  await database.destroy();
});

function stored() {
  const event = parseStripeWebhookEvent({
    ...stripeEventFixture('payment_intent.succeeded'),
    id: `evt_${randomUUID()}`,
  });
  return { id: event.id, endpoint: 'platform' as const, event };
}

describe('Postgres Stripe event repository', () => {
  it('deduplicates deliveries, claims atomically and fences stale completions', async () => {
    const item = stored();
    expect(await repository.store(item)).toBe('inserted');
    expect(await repository.store(item)).toBe('pending');
    const claims = await Promise.all([
      repository.claim(item.id),
      repository.claim(item.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find((candidate) => candidate !== null);
    if (!claim) throw new Error('Expected one claim');
    expect(claim.event.id).toBe(item.id);
    await expect(repository.complete(item.id, randomUUID())).rejects.toThrow(
      'stale',
    );
    await repository.complete(item.id, claim.claimToken);
    expect(await repository.store(item)).toBe('processed');
    expect(await repository.claim(item.id)).toBeNull();
  });

  it('releases a failed handler claim for retry while counting attempts', async () => {
    const item = stored();
    await repository.store(item);
    const first = await repository.claim(item.id);
    if (!first) throw new Error('Expected first claim');
    await repository.fail(item.id, first.claimToken, 'STRIPE_DISPATCH_FAILED');
    const second = await repository.claim(item.id);
    if (!second) throw new Error('Expected retry claim');
    expect(second.claimToken).not.toBe(first.claimToken);
    const row = await database
      .selectFrom('stripe_events')
      .select(['attempts', 'error'])
      .where('stripe_event_id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ attempts: 2, error: 'STRIPE_DISPATCH_FAILED' });
    await repository.complete(item.id, second.claimToken);
  });

  it('reclaims an expired lease and rejects the prior worker token', async () => {
    const item = stored();
    await repository.store(item);
    const first = await repository.claim(item.id);
    if (!first) throw new Error('Expected first claim');
    await sql`
      UPDATE stripe_events SET lease_expires_at = now() - interval '1 second'
      WHERE stripe_event_id = ${item.id}
    `.execute(database);
    const second = await repository.claim(item.id);
    if (!second) throw new Error('Expected replacement claim');
    await expect(
      repository.complete(item.id, first.claimToken),
    ).rejects.toThrow('stale');
    await repository.complete(item.id, second.claimToken);
  });

  it('rejects a conflicting event ID', async () => {
    const item = stored();
    await repository.store(item);
    await expect(
      repository.store({
        ...item,
        event: parseStripeWebhookEvent({
          ...item.event,
          type: 'account.updated',
        }),
      }),
    ).rejects.toThrow('Conflicting Stripe event ID');
  });

  it('lists unclaimed and expired events for scheduled recovery', async () => {
    const fresh = stored();
    const leased = stored();
    await repository.store(fresh);
    await repository.store(leased);
    const claim = await repository.claim(leased.id);
    if (!claim) throw new Error('Expected lease');
    const first = await repository.pendingIds();
    expect(first).toContain(fresh.id);
    expect(first).not.toContain(leased.id);
    await sql`
      UPDATE stripe_events SET lease_expires_at = now() - interval '1 second'
      WHERE stripe_event_id = ${leased.id}
    `.execute(database);
    expect(await repository.pendingIds()).toContain(leased.id);
    await repository.complete(leased.id, claim.claimToken);
    expect(await repository.pendingIds()).not.toContain(leased.id);
  });
});
