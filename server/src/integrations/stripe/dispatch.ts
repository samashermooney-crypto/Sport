import {
  isHandledStripeEvent,
  type HandledStripeEventType,
  type StripeWebhookEvent,
} from './webhooks.js';

export type StripeEndpoint = 'platform' | 'connect';

export interface StoredStripeEvent {
  id: string;
  endpoint: StripeEndpoint;
  event: StripeWebhookEvent;
}

export interface ClaimedStripeEvent extends StoredStripeEvent {
  claimToken: string;
}

/**
 * Implementations must atomically dedupe by Stripe event ID and atomically claim
 * a pending event. A claimed event must not be returned to another worker until
 * its lease expires or the first worker marks it failed.
 */
export interface StripeEventRepository {
  store(
    event: StoredStripeEvent,
  ): Promise<'inserted' | 'pending' | 'processed'>;
  claim(eventId: string): Promise<ClaimedStripeEvent | null>;
  complete(eventId: string, claimToken: string): Promise<void>;
  fail(eventId: string, claimToken: string, message: string): Promise<void>;
}

export type StripeEventHandler = (event: StripeWebhookEvent) => Promise<void>;
export type StripeEventHandlers = Partial<
  Record<HandledStripeEventType, StripeEventHandler>
>;

export class StripeEventDispatcher {
  constructor(
    private readonly repository: StripeEventRepository,
    private readonly handlers: StripeEventHandlers,
  ) {}

  async dispatch(eventId: string): Promise<'processed' | 'already_claimed'> {
    const stored = await this.repository.claim(eventId);
    if (!stored) return 'already_claimed';
    try {
      if (isHandledStripeEvent(stored.event.type)) {
        const handler = this.handlers[stored.event.type];
        if (!handler) {
          throw new Error(`No handler registered for ${stored.event.type}`);
        }
        await handler(stored.event);
      }
      await this.repository.complete(eventId, stored.claimToken);
      return 'processed';
    } catch (error) {
      await this.repository.fail(
        eventId,
        stored.claimToken,
        'STRIPE_DISPATCH_FAILED',
      );
      throw error;
    }
  }
}
