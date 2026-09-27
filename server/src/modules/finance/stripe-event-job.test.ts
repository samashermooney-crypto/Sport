import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { StripeEventRepository } from '../../integrations/stripe/dispatch.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { stripeEventFixture } from '../../integrations/stripe/webhook-fixtures.js';
import {
  handledStripeEventTypes,
  parseStripeWebhookEvent,
} from '../../integrations/stripe/webhooks.js';

import {
  dispatchFinanceStripeEvent,
  financeStripeEventHandlers,
  replayStoredStripeEvents,
} from './stripe-event-job.js';

describe('finance Stripe event worker', () => {
  it('registers exactly one handler for every accepted event type', async () => {
    const database = createDatabase('postgres://unused@localhost/unused');
    try {
      const handlers = financeStripeEventHandlers(
        database,
        {} as PaymentsGateway,
      );
      expect(Object.keys(handlers).sort()).toEqual(
        [...handledStripeEventTypes].sort(),
      );
    } finally {
      await database.destroy();
    }
  });

  it('rejects malformed jobs before claiming an event', async () => {
    const database = createDatabase('postgres://unused@localhost/unused');
    let claims = 0;
    const repository = {
      claim: () => {
        claims += 1;
        return Promise.resolve(null);
      },
    } as unknown as StripeEventRepository;
    const dependencies = {
      database,
      gateway: {} as PaymentsGateway,
      repository,
    };
    try {
      await expect(
        dispatchFinanceStripeEvent({ eventId: 'invalid' }, dependencies),
      ).rejects.toThrow();
      expect(claims).toBe(0);
      await expect(
        dispatchFinanceStripeEvent({ eventId: 'evt_test' }, dependencies),
      ).resolves.toBe('already_claimed');
      expect(claims).toBe(1);
    } finally {
      await database.destroy();
    }
  });

  it('rejects platform money events on the Connect endpoint', async () => {
    const database = createDatabase('postgres://unused@localhost/unused');
    try {
      const handlers = financeStripeEventHandlers(
        database,
        {} as PaymentsGateway,
      );
      const event = parseStripeWebhookEvent({
        ...stripeEventFixture('payment_intent.succeeded'),
        account: 'acct_wrong_endpoint',
      });
      await expect(
        handlers['payment_intent.succeeded']?.(event),
      ).rejects.toThrow('wrong endpoint');
    } finally {
      await database.destroy();
    }
  });

  it('replays later events after a poison event and surfaces the failure', async () => {
    const seen: string[] = [];
    const repository = {
      pendingIds: () => Promise.resolve(['evt_bad', 'evt_good']),
    };
    await expect(
      replayStoredStripeEvents(repository, (id) => {
        seen.push(id);
        return id === 'evt_bad'
          ? Promise.reject(new Error('Bad event'))
          : Promise.resolve('processed' as const);
      }),
    ).rejects.toThrow('Stripe event replay failed');
    expect(seen).toEqual(['evt_bad', 'evt_good']);
  });
});
