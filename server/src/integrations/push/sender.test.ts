import type { Agent } from 'node:https';

import { describe, expect, it } from 'vitest';

import { sendPushAndCleanup, WebPushSender } from './sender';
import type { PushEndpointResolver, WebPushClient } from './sender';

describe('WebPushSender', () => {
  const sub = {
    endpoint: 'https://fcm.googleapis.com/x',
    keys: { p256dh: 'key', auth: 'auth' },
  };
  const publicResolver: PushEndpointResolver = () =>
    Promise.resolve([{ address: '8.8.8.8', family: 4 }]);
  const createSender = (
    client: WebPushClient,
    resolver: PushEndpointResolver = publicResolver,
  ) =>
    new WebPushSender(
      client,
      {
        subject: 'mailto:ops@example.test',
        publicKey: 'pub',
        privateKey: 'private',
      },
      resolver,
    );

  it('marks expired subscriptions for cleanup', async () => {
    const sender = createSender({
      setVapidDetails() {},
      sendNotification() {
        return Promise.reject(
          Object.assign(new Error('gone'), { statusCode: 410 }),
        );
      },
    });
    await expect(
      sender.send(sub, { title: 'Schedule', body: 'Updated' }),
    ).resolves.toEqual({ status: 'invalid-subscription' });
  });
  it('surfaces transient provider errors for retries', async () => {
    const sender = createSender({
      setVapidDetails() {},
      sendNotification() {
        return Promise.reject(
          Object.assign(new Error('unavailable'), { statusCode: 503 }),
        );
      },
    });
    await expect(
      sender.send(sub, { title: 'Schedule', body: 'Updated' }),
    ).rejects.toThrow('unavailable');
  });
  it('removes invalid endpoints through the subscription cleanup boundary', async () => {
    const sender = createSender({
      setVapidDetails() {},
      sendNotification() {
        return Promise.reject(
          Object.assign(new Error('gone'), { statusCode: 404 }),
        );
      },
    });
    const removed: string[] = [];
    await expect(
      sendPushAndCleanup(
        sender,
        sub,
        { title: 'Schedule', body: 'Updated' },
        {
          removeInvalidEndpoint: (endpoint) => {
            removed.push(endpoint);
            return Promise.resolve();
          },
        },
      ),
    ).resolves.toEqual({ status: 'invalid-subscription' });
    expect(removed).toEqual([sub.endpoint]);
  });
  it('returns a provider message ID when the push service supplies one', async () => {
    const sender = createSender({
      setVapidDetails() {},
      sendNotification() {
        return Promise.resolve({
          statusCode: 201,
          headers: { 'x-message-id': 'push_fixture_1' },
        });
      },
    });
    await expect(
      sender.send(sub, { title: 'Schedule', body: 'Updated' }),
    ).resolves.toEqual({ status: 'sent', providerId: 'push_fixture_1' });
  });

  it('rejects unsafe or non-provider endpoints before DNS or transport', async () => {
    let resolutionCount = 0;
    let transportCount = 0;
    const sender = createSender(
      {
        setVapidDetails() {},
        sendNotification() {
          transportCount += 1;
          return Promise.resolve({ statusCode: 201 });
        },
      },
      () => {
        resolutionCount += 1;
        return publicResolver('fcm.googleapis.com');
      },
    );

    for (const endpoint of [
      'http://fcm.googleapis.com/subscription',
      'https://127.0.0.1/subscription',
      'https://localhost/subscription',
      'https://attacker.example/subscription',
      'https://fcm.googleapis.com:8443/subscription',
    ]) {
      await expect(
        sender.send({ ...sub, endpoint }, { title: 'Notice', body: 'Safe' }),
      ).resolves.toEqual({ status: 'invalid-subscription' });
    }
    expect(resolutionCount).toBe(0);
    expect(transportCount).toBe(0);
  });

  it('rejects a provider hostname resolving to any private or link-local address', async () => {
    let transportCount = 0;
    const sender = createSender(
      {
        setVapidDetails() {},
        sendNotification() {
          transportCount += 1;
          return Promise.resolve({ statusCode: 201 });
        },
      },
      () =>
        Promise.resolve([
          { address: '8.8.8.8', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ]),
    );
    await expect(
      sender.send(sub, { title: 'Notice', body: 'Safe' }),
    ).resolves.toEqual({ status: 'invalid-subscription' });
    expect(transportCount).toBe(0);
  });

  it('pins transport DNS lookups to the validated provider addresses', async () => {
    let agent: Agent | undefined;
    const sender = createSender({
      setVapidDetails() {},
      sendNotification(_subscription, _payload, options) {
        agent = options?.agent;
        return Promise.resolve({ statusCode: 201 });
      },
    });
    await expect(
      sender.send(sub, { title: 'Notice', body: 'Safe' }),
    ).resolves.toEqual({ status: 'sent' });
    const pinnedLookup = agent?.options.lookup;
    if (!pinnedLookup) throw new Error('Pinned agent lookup is missing');
    const addresses = await new Promise<unknown>((resolve, reject) => {
      pinnedLookup(
        'fcm.googleapis.com',
        { family: 0, all: true },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        },
      );
    });
    expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
    agent?.destroy();
  });
});
