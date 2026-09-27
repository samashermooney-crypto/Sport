import type { AddressInfo } from 'node:net';

import express from 'express';
import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ClaimedStripeEvent,
  StoredStripeEvent,
  StripeEventRepository,
} from './dispatch.js';
import { StripeSdkGateway } from './sdk.js';
import { stripeEventFixture } from './webhook-fixtures.js';
import { createStripeWebhookRouter } from './webhook-routes.js';

const stripe = new Stripe('sk_test_fixture');
const gateway = new StripeSdkGateway('sk_test_fixture', stripe);
const platformSecret = 'whsec_platform_fixture';
const connectSecret = 'whsec_connect_fixture';

class Repository implements StripeEventRepository {
  readonly events = new Map<string, StoredStripeEvent>();
  readonly processed = new Set<string>();

  store(
    event: StoredStripeEvent,
  ): Promise<'inserted' | 'pending' | 'processed'> {
    if (this.processed.has(event.id)) return Promise.resolve('processed');
    if (this.events.has(event.id)) return Promise.resolve('pending');
    this.events.set(event.id, event);
    return Promise.resolve('inserted');
  }
  claim(eventId: string): Promise<ClaimedStripeEvent | null> {
    const event = this.events.get(eventId);
    return Promise.resolve(
      event ? { ...event, claimToken: 'test-claim' } : null,
    );
  }
  complete(eventId: string): Promise<void> {
    this.processed.add(eventId);
    return Promise.resolve();
  }
  fail(): Promise<void> {
    return Promise.resolve();
  }
}

const servers: ReturnType<ReturnType<typeof express>['listen']>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function start(repository = new Repository()) {
  const enqueue = vi
    .fn<(eventId: string) => Promise<void>>()
    .mockResolvedValue();
  const app = express();
  app.use(
    '/api/v1/webhooks',
    createStripeWebhookRouter({
      gateway,
      repository,
      enqueue,
      platformSecret,
      connectSecret,
    }),
  );
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(address.port)}/api/v1/webhooks`,
    repository,
    enqueue,
  };
}

function signedBody(
  type: 'payment_intent.succeeded' | 'account.updated',
  connect: boolean,
) {
  const fixture = stripeEventFixture(type);
  const payload = JSON.stringify(
    connect ? { ...fixture, account: 'acct_fixture' } : fixture,
  );
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: connect ? connectSecret : platformSecret,
  });
  return { payload, signature };
}

describe('Stripe webhook HTTP endpoints', () => {
  it('accepts a signed platform event and dedupes its persistence', async () => {
    const test = await start();
    const { payload, signature } = signedBody(
      'payment_intent.succeeded',
      false,
    );
    const send = () =>
      fetch(`${test.base}/stripe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(test.repository.events.size).toBe(1);
    expect(test.enqueue).toHaveBeenCalledTimes(2);
  });

  it('requires Connect signatures and a connected account on the Connect endpoint', async () => {
    const test = await start();
    const valid = signedBody('account.updated', true);
    const response = await fetch(`${test.base}/stripe-connect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': valid.signature,
      },
      body: valid.payload,
    });
    expect(response.status).toBe(200);
    expect(test.repository.events.get('evt_account_updated')?.endpoint).toBe(
      'connect',
    );
    const wrongEndpoint = await fetch(`${test.base}/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': valid.signature,
      },
      body: valid.payload,
    });
    expect(wrongEndpoint.status).toBe(400);
  });

  it('rejects altered bytes before storing or enqueueing', async () => {
    const test = await start();
    const { payload, signature } = signedBody(
      'payment_intent.succeeded',
      false,
    );
    const response = await fetch(`${test.base}/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      body: `${payload} `,
    });
    expect(response.status).toBe(400);
    expect(test.repository.events.size).toBe(0);
    expect(test.enqueue).not.toHaveBeenCalled();
  });
});
