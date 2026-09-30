import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMailpitEmailSender,
  createResendEmailSender,
  FakeEmailSender,
  mailpitSmtpPort,
  verifyResendWebhook,
} from './sender';

const smtp = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: smtp.createTransport },
}));

describe('email adapters', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    await expect(sender.send(message)).resolves.toEqual({
      providerId: 'fake-email-2',
    });
  });
  it('uses the configurable local Mailpit SMTP port safely', () => {
    expect(mailpitSmtpPort('2525')).toBe(2525);
    expect(mailpitSmtpPort(undefined)).toBe(1025);
    expect(() => mailpitSmtpPort('70000')).toThrow('valid TCP port');
  });
  it('reads the Mailpit SMTP port from the environment and defaults to 1025', () => {
    smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail });
    vi.stubEnv('ATHLENTRY_MAILPIT_SMTP_PORT', '2526');
    createMailpitEmailSender();
    expect(smtp.createTransport).toHaveBeenLastCalledWith({
      host: '127.0.0.1',
      port: 2526,
      secure: false,
    });

    vi.stubEnv('ATHLENTRY_MAILPIT_SMTP_PORT', '');
    createMailpitEmailSender();
    expect(smtp.createTransport).toHaveBeenLastCalledWith({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
    });
  });
  it('returns the Mailpit SMTP message ID', async () => {
    smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail });
    smtp.sendMail.mockResolvedValue({
      messageId: '<preview-1@athlentry.invalid>',
    });
    const sender = createMailpitEmailSender({
      host: '127.0.0.1',
      port: 2525,
    });
    await expect(
      sender.send({
        to: 'person@example.test',
        subject: 'Preview',
        text: 'Text',
      }),
    ).resolves.toEqual({ providerId: '<preview-1@athlentry.invalid>' });
    expect(smtp.createTransport).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 2525,
      secure: false,
    });
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
        return Promise.resolve(
          new Response(
            JSON.stringify({ id: `re_fixture_${String(requests.length)}` }),
            {
              status: 200,
            },
          ),
        );
      },
    });
    await expect(
      sender.send({
        to: 'person@example.test',
        subject: 'Security',
        text: 'Notice',
        kind: 'security',
      }),
    ).resolves.toEqual({ providerId: 're_fixture_1' });
    await expect(
      sender.send({
        to: 'person@example.test',
        subject: 'Campaign',
        text: 'News',
        kind: 'campaign',
        idempotencyKey: 'campaign/1',
      }),
    ).resolves.toEqual({ providerId: 're_fixture_2' });
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
