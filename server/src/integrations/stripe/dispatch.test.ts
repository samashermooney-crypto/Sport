import { describe, expect, it, vi } from 'vitest';

import {
  StripeEventDispatcher,
  type ClaimedStripeEvent,
  type StoredStripeEvent,
  type StripeEventRepository,
} from './dispatch.js';
import { stripeEventFixture } from './webhook-fixtures.js';
import { parseStripeWebhookEvent } from './webhooks.js';

class MemoryRepository implements StripeEventRepository {
  private readonly events = new Map<string, StoredStripeEvent>();
  private readonly states = new Map<
    string,
    'pending' | 'claimed' | 'processed'
  >();
  failures = 0;

  store(
    event: StoredStripeEvent,
  ): Promise<'inserted' | 'pending' | 'processed'> {
    const state = this.states.get(event.id);
    if (state === 'processed') return Promise.resolve('processed');
    if (state) return Promise.resolve('pending');
    this.events.set(event.id, event);
    this.states.set(event.id, 'pending');
    return Promise.resolve('inserted');
  }
  claim(eventId: string): Promise<ClaimedStripeEvent | null> {
    if (this.states.get(eventId) !== 'pending') return Promise.resolve(null);
    this.states.set(eventId, 'claimed');
    const event = this.events.get(eventId);
    return Promise.resolve(
      event ? { ...event, claimToken: 'claim-test' } : null,
    );
  }
  complete(eventId: string, claimToken: string): Promise<void> {
    if (claimToken !== 'claim-test') throw new Error('Stale claim');
    this.states.set(eventId, 'processed');
    return Promise.resolve();
  }
  fail(eventId: string, claimToken: string): Promise<void> {
    if (claimToken !== 'claim-test') throw new Error('Stale claim');
    this.failures += 1;
    this.states.set(eventId, 'pending');
    return Promise.resolve();
  }
}

const stored: StoredStripeEvent = {
  id: 'evt_payment_intent_succeeded',
  endpoint: 'platform',
  event: parseStripeWebhookEvent(
    stripeEventFixture('payment_intent.succeeded'),
  ),
};

describe('Stripe event dispatcher', () => {
  it('claims once under concurrent delivery and ignores processed replays', async () => {
    const repository = new MemoryRepository();
    await repository.store(stored);
    const handler = vi.fn<() => Promise<void>>().mockResolvedValue();
    const dispatcher = new StripeEventDispatcher(repository, {
      'payment_intent.succeeded': handler,
    });
    const results = await Promise.all([
      dispatcher.dispatch(stored.id),
      dispatcher.dispatch(stored.id),
    ]);
    expect(results).toContain('processed');
    expect(results).toContain('already_claimed');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await dispatcher.dispatch(stored.id)).toBe('already_claimed');
  });

  it('keeps failed handlers retryable without silently acknowledging them', async () => {
    const repository = new MemoryRepository();
    await repository.store(stored);
    const handler = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce();
    const dispatcher = new StripeEventDispatcher(repository, {
      'payment_intent.succeeded': handler,
    });
    await expect(dispatcher.dispatch(stored.id)).rejects.toThrow(
      'temporary failure',
    );
    expect(repository.failures).toBe(1);
    expect(await dispatcher.dispatch(stored.id)).toBe('processed');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a known event has no registered handler', async () => {
    const repository = new MemoryRepository();
    await repository.store(stored);
    const dispatcher = new StripeEventDispatcher(repository, {});
    await expect(dispatcher.dispatch(stored.id)).rejects.toThrow(
      'No handler registered',
    );
    expect(repository.failures).toBe(1);
  });
});
