import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createResendEmailSender,
  FakeEmailSender,
  mailpitSmtpPort,
  verifyResendWebhook,
} from './sender';

describe('email adapters', () => {
  it('keeps FakeEmailSender behavior and retains rich message fields', async () => {
    const sender = new FakeEmailSender();
    const message = {
      to: 'guardian@example.test',
      subject: 'Hello',
      text: 'Plain',
      html: '<p>Rich</p>',
      attachments: [{ filename: 'file.pdf', content: new Uint8Array([1]) }],
    };
    await sender.send(message);
    expect(sender.messages).toEqual([message]);
  });
  it('uses the configurable local Mailpit SMTP port safely', () => {
    expect(mailpitSmtpPort('2525')).toBe(2525);
    expect(mailpitSmtpPort(undefined)).toBe(1025);
    expect(() => mailpitSmtpPort('70000')).toThrow('valid TCP port');
  });
  it('verifies signed Resend webhooks and rejects stale timestamps', () => {
    const rawBody = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: 'fixture-1' },
    });
    const secret = Buffer.from('a fixture webhook secret').toString('base64');
    const timestamp = '1700000000';
    const id = 'evt_fixture';
    const signature = createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(`${id}.${timestamp}.${rawBody}`)
      .digest('base64');
    expect(
      verifyResendWebhook({
        rawBody,
        id,
        timestamp,
        signature: `v1,${signature}`,
        secret: `whsec_${secret}`,
        now: 1700000000,
      }).type,
    ).toBe('email.delivered');
    expect(() =>
      verifyResendWebhook({
        rawBody,
        id,
        timestamp,
        signature: `v1,${signature}`,
        secret: `whsec_${secret}`,
        now: 1700000400,
      }),
    ).toThrow('expired');
  });
  it('keeps tracked campaign mail on a separate sender domain', async () => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> =
      [];
    const sender = createResendEmailSender({
      apiKey: 'fixture-key',
      from: 'Athlentry <security@notify.example.test>',
      campaignFrom: 'Athlentry <campaign@track.example.test>',
      fetch: (_url, init) => {
        const payload = typeof init?.body === 'string' ? init.body : '{}';
        requests.push({
          body: JSON.parse(payload) as Record<string, unknown>,
          headers: new Headers(init?.headers),
        });
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    await sender.send({
      to: 'person@example.test',
      subject: 'Security',
      text: 'Notice',
      kind: 'security',
    });
    await sender.send({
      to: 'person@example.test',
      subject: 'Campaign',
      text: 'News',
      kind: 'campaign',
      idempotencyKey: 'campaign/1',
    });
    expect(requests[0]?.body.from).toBe(
      'Athlentry <security@notify.example.test>',
    );
    expect(requests[1]?.body.from).toBe(
      'Athlentry <campaign@track.example.test>',
    );
    expect(requests[1]?.headers.get('idempotency-key')).toBe('campaign/1');
    expect(requests[0]?.body).not.toHaveProperty('open_tracking');
  });
});
