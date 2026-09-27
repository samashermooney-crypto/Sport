import { expect, test } from '@playwright/test';

import { WebPushSender } from '../../server/src/integrations/push/sender';
import type { WebPushClient } from '../../server/src/integrations/push/sender';

test.fixme('SEC-SSRF / Track C: reject internal push endpoints before transport', async () => {
  const transportCalls: string[] = [];
  const client: WebPushClient = {
    setVapidDetails() {},
    sendNotification(subscription) {
      transportCalls.push(subscription.endpoint);
      return Promise.resolve({ statusCode: 201 });
    },
  };
  const sender = new WebPushSender(client, {
    subject: 'mailto:security@example.test',
    publicKey: 'test-public-key',
    privateKey: 'test-private-key',
  });

  const result = await sender.send(
    {
      endpoint: 'https://127.0.0.1:443/latest/meta-data',
      keys: { p256dh: 'test-public-key', auth: 'test-auth' },
    },
    { title: 'Security test', body: 'Synthetic push only' },
  );

  expect(result).toEqual({ status: 'invalid-subscription' });
  expect(transportCalls).toEqual([]);
});
