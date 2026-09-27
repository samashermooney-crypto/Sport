import { describe, expect, it } from 'vitest';

import { sendPushAndCleanup, WebPushSender } from './sender';

describe('WebPushSender', () => {
  const sub = {
    endpoint: 'https://push.example.test/x',
    keys: { p256dh: 'key', auth: 'auth' },
  };
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
    );
    await expect(
      sender.send(sub, { title: 'Schedule', body: 'Updated' }),
    ).resolves.toEqual({ status: 'sent', providerId: 'push_fixture_1' });
  });
});
