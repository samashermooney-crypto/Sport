import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { handleTwilioInbound } from './inbound';
import {
  createTwilioSmsSender,
  FakeSmsSender,
  parseSmsCommand,
  parseTwilioInbound,
  verifyTwilioStatusCallback,
} from './sender';

describe('SMS adapters', () => {
  it('maps common opt-out commands', () => {
    expect(parseSmsCommand('Stop!')).toBe('STOP');
    expect(parseSmsCommand('START')).toBe('START');
    expect(parseSmsCommand('HELP')).toBe('HELP');
    expect(parseSmsCommand('practice is canceled')).toBeNull();
  });
  it('requires a valid Twilio signature and updates suppression through the adapter contract', async () => {
    const authToken = 'fixture-token';
    const url = 'https://example.test/webhooks/twilio/inbound';
    const params = {
      From: '+15555550123',
      To: '+15555550100',
      Body: 'STOP',
      MessageSid: 'SMfixture',
    };
    const input = {
      url,
      params,
      authToken,
      signature: createHmac('sha1', authToken)
        .update(
          url +
            Object.keys(params)
              .sort()
              .map((key) => key + params[key as keyof typeof params])
              .join(''),
        )
        .digest('base64'),
    };
    expect(parseTwilioInbound(input).command).toBe('STOP');
    const suppressed: string[] = [];
    await handleTwilioInbound(input, {
      suppress: (phone) => {
        suppressed.push(phone);
        return Promise.resolve();
      },
      unsuppress: () => Promise.resolve(),
    });
    expect(suppressed).toEqual(['+15555550123']);
    expect(() =>
      parseTwilioInbound({ ...input, signature: 'invalid' }),
    ).toThrow('signature');
  });
  it('verifies status callbacks', () => {
    const authToken = 'fixture-token';
    const url = 'https://example.test/status';
    const params = { MessageSid: 'SMfixture', MessageStatus: 'delivered' };
    const signature = createHmac('sha1', authToken)
      .update(
        url +
          Object.keys(params)
            .sort()
            .map((key) => key + params[key as keyof typeof params])
            .join(''),
      )
      .digest('base64');
    expect(
      verifyTwilioStatusCallback({ url, params, signature, authToken }),
    ).toMatchObject({ providerId: 'SMfixture', status: 'delivered' });
  });
  it('stores sends in fake adapter', async () => {
    const sender = new FakeSmsSender();
    await expect(
      sender.send({ to: '+15555550123', body: 'Preview' }),
    ).resolves.toEqual({ providerId: 'fake-1' });
    expect(sender.messages).toHaveLength(1);
  });
  it('sends through the configured Messaging Service with signed status callback destination', async () => {
    let submitted: URLSearchParams | undefined;
    const sender = createTwilioSmsSender({
      accountSid: 'ACfixture',
      authToken: 'fake-token',
      messagingServiceSid: 'MGfixture',
      statusCallbackUrl:
        'https://api.example.test/api/v1/webhooks/twilio/sms-status',
      fetch: (_url, init) => {
        submitted = init?.body as URLSearchParams;
        return Promise.resolve(
          new Response('{"sid":"SMfixture"}', { status: 201 }),
        );
      },
    });
    await expect(
      sender.send({ to: '+15555550123', body: 'Preview' }),
    ).resolves.toMatchObject({ providerId: 'SMfixture' });
    expect(submitted?.get('MessagingServiceSid')).toBe('MGfixture');
    expect(submitted?.get('StatusCallback')).toBe(
      'https://api.example.test/api/v1/webhooks/twilio/sms-status',
    );
  });
  it('rejects a successful Twilio response without its provider message ID', async () => {
    const sender = createTwilioSmsSender({
      accountSid: 'ACfixture',
      authToken: 'fake-token',
      messagingServiceSid: 'MGfixture',
      statusCallbackUrl: 'https://api.example.test/status',
      fetch: () => Promise.resolve(new Response('{}', { status: 201 })),
    });
    await expect(
      sender.send({ to: '+15555550123', body: 'Preview' }),
    ).rejects.toThrow('message ID');
  });
});
