import type { Agent } from 'node:https';
import type { LookupFunction } from 'node:net';

import { describe, expect, it } from 'vitest';

import { sendPushAndCleanup, WebPushSender } from './sender';

describe('WebPushSender', () => {
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint',
    keys: { p256dh: 'key', auth: 'auth' },
  };
  const resolveAddresses = () =>
    Promise.resolve([{ address: '8.8.8.8', family: 4 }]);
  it('marks expired subscriptions for cleanup', async () => {
    const sender = new WebPushSender(
      {
        setVapidDetails() {},
        sendNotification() {
          return Promise.reject(
            Object.assign(new Error('gone'), { statusCode: 410 }),
          );
        },
      },
      {
        subject: 'mailto:ops@example.test',
        publicKey: 'pub',
        privateKey: 'private',
      },
      resolveAddresses,
    );
    await expect(
      sender.send(sub, { title: 'Schedule', body: 'Updated' }),
    ).resolves.toEqual({ status: 'invalid-subscription' });
  });
  it('surfaces transient provider errors for retries', async () => {
    const sender = new WebPushSender(
      {
        setVapidDetails() {},
        sendNotification() {
          return Promise.reject(
            Object.assign(new Error('unavailable'), { statusCode: 503 }),
          );
        },
      },
      {
        subject: 'https://example.test',
        publicKey: 'pub',
        privateKey: 'private',
      },
      resolveAddresses,
    );
    await expect(
      sender.send(sub, { title: 'Schedule', body: 'Updated' }),
    ).rejects.toThrow('unavailable');
  });
  it('removes invalid endpoints through the subscription cleanup boundary', async () => {
    const sender = new WebPushSender(
      {
        setVapidDetails() {},
        sendNotification() {
          return Promise.reject(
            Object.assign(new Error('gone'), { statusCode: 404 }),
          );
        },
      },
      {
        subject: 'mailto:ops@example.test',
        publicKey: 'pub',
        privateKey: 'private',
      },
      resolveAddresses,
    );
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
    const sender = new WebPushSender(
      {
        setVapidDetails() {},
        sendNotification() {
          return Promise.resolve({
            statusCode: 201,
            headers: { 'x-message-id': 'push_fixture_1' },
          });
        },
      },
      {
        subject: 'mailto:ops@example.test',
        publicKey: 'pub',
        privateKey: 'private',
      },
      resolveAddresses,
    );
    await expect(
      sender.send(sub, { title: 'Schedule', body: 'Updated' }),
    ).resolves.toEqual({ status: 'sent', providerId: 'push_fixture_1' });
  });

  it('rejects resolved private push destinations before transport', async () => {
    let transportCalls = 0;
    const sender = new WebPushSender(
      {
        setVapidDetails() {},
        sendNotification() {
          transportCalls += 1;
          return Promise.resolve({ statusCode: 201 });
        },
      },
      {
        subject: 'mailto:ops@example.test',
        publicKey: 'pub',
        privateKey: 'private',
      },
      () =>
        Promise.resolve([
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]),
    );
    await expect(
      sender.send(sub, { title: 'Schedule', body: 'Updated' }),
    ).resolves.toEqual({ status: 'invalid-subscription' });
    expect(transportCalls).toBe(0);
  });

  it.each([
    ['IPv6 loopback', '::1'],
    ['IPv6 unique-local', 'fd00::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['Teredo', '2001:0:4136:e378::1'],
    ['IETF protocol assignment', '2001:100::1'],
    ['IPv6 documentation', '3fff::1'],
    ['6to4', '2002:0808:0808::1'],
  ])(
    'rejects %s push destinations before transport',
    async (_name, address) => {
      let transportCalls = 0;
      const sender = new WebPushSender(
        {
          setVapidDetails() {},
          sendNotification() {
            transportCalls += 1;
            return Promise.resolve({ statusCode: 201 });
          },
        },
        {
          subject: 'mailto:ops@example.test',
          publicKey: 'pub',
          privateKey: 'private',
        },
        () => Promise.resolve([{ address, family: 6 }]),
      );
      await expect(
        sender.send(sub, { title: 'Schedule', body: 'Updated' }),
      ).resolves.toEqual({ status: 'invalid-subscription' });
      expect(transportCalls).toBe(0);
    },
  );

  it('pins the validated public address for the transport lookup', async () => {
    let resolverCalls = 0;
    const sender = new WebPushSender(
      {
        setVapidDetails() {},
        async sendNotification(_subscription, _payload, options) {
          const lookup = (
            options?.agent as Agent & {
              options: { lookup: LookupFunction };
            }
          ).options.lookup;
          const resolvePinnedAddress = () =>
            new Promise<string>((resolve, reject) => {
              lookup(
                'fcm.googleapis.com',
                { family: 4, all: false, hints: 0, verbatim: true },
                (error, address) => {
                  if (error) {
                    reject(error);
                    return;
                  }
                  if (Array.isArray(address)) {
                    reject(new Error('Expected one pinned address'));
                    return;
                  }
                  resolve(address);
                },
              );
            });
          expect(await resolvePinnedAddress()).toBe('8.8.8.8');
          expect(await resolvePinnedAddress()).toBe('8.8.8.8');
          return { statusCode: 201 };
        },
      },
      {
        subject: 'mailto:ops@example.test',
        publicKey: 'pub',
        privateKey: 'private',
      },
      () => {
        resolverCalls += 1;
        return Promise.resolve([{ address: '8.8.8.8', family: 4 }]);
      },
    );
    await expect(
      sender.send(sub, { title: 'Schedule', body: 'Updated' }),
    ).resolves.toEqual({ status: 'sent' });
    expect(resolverCalls).toBe(1);
  });
});
