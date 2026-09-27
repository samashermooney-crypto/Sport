import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SmsMessage {
  to: string;
  body: string;
  idempotencyKey?: string;
}
export interface SmsSender {
  send(message: SmsMessage): Promise<{ providerId: string }>;
}
export class FakeSmsSender implements SmsSender {
  readonly messages: SmsMessage[] = [];
  send(message: SmsMessage) {
    this.messages.push(message);
    return Promise.resolve({
      providerId: `fake-${String(this.messages.length)}`,
    });
  }
}
export class PreviewSmsSender implements SmsSender {
  readonly messages: SmsMessage[] = [];
  send(message: SmsMessage) {
    this.messages.push(message);
    return Promise.resolve({
      providerId: `preview-${String(this.messages.length)}`,
    });
  }
}

export function createTwilioSmsSender(options: {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  statusCallbackUrl: string;
  fetch?: typeof fetch;
}): SmsSender {
  const fetcher = options.fetch ?? fetch;
  if (
    !options.accountSid ||
    !options.authToken ||
    !options.messagingServiceSid ||
    !URL.canParse(options.statusCallbackUrl) ||
    !options.statusCallbackUrl.startsWith('https://')
  )
    throw new Error('Twilio Messaging Service configuration is incomplete');
  return {
    async send(message) {
      const body = new URLSearchParams({
        To: message.to,
        Body: message.body,
        MessagingServiceSid: options.messagingServiceSid,
        StatusCallback: options.statusCallbackUrl,
      });
      const response = await fetcher(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
            ...(message.idempotencyKey
              ? { 'Idempotency-Key': message.idempotencyKey }
              : {}),
          },
          body,
        },
      );
      if (!response.ok)
        throw new Error(
          `Twilio request failed with HTTP ${String(response.status)}`,
        );
      const result: unknown = await response.json();
      const sid =
        result &&
        typeof result === 'object' &&
        'sid' in result &&
        typeof result.sid === 'string'
          ? result.sid
          : undefined;
      if (!sid) throw new Error('Twilio response did not include a message ID');
      return { providerId: sid };
    },
  };
}

export type SmsCommand = 'STOP' | 'START' | 'HELP' | null;
export function parseSmsCommand(body: string): SmsCommand {
  const command = body
    .trim()
    .toUpperCase()
    .replace(/[.!?]+$/, '');
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(command))
    return 'STOP';
  if (/^(START|YES|UNSTOP)$/.test(command)) return 'START';
  if (/^HELP$/.test(command)) return 'HELP';
  return null;
}
export interface TwilioInboundMessage {
  from: string;
  to: string;
  body: string;
  messageSid: string;
  command: SmsCommand;
}
export function verifyTwilioSignature(input: {
  url: string;
  params: Record<string, string>;
  signature: string;
  authToken: string;
}): boolean {
  const content = Object.keys(input.params)
    .sort()
    .reduce((value, key) => value + key + (input.params[key] ?? ''), input.url);
  const expected = createHmac('sha1', input.authToken)
    .update(content)
    .digest('base64');
  const actual = Buffer.from(input.signature);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
export function parseTwilioInbound(input: {
  url: string;
  params: Record<string, string>;
  signature: string;
  authToken: string;
}): TwilioInboundMessage {
  if (!verifyTwilioSignature(input))
    throw new Error('Twilio signature is invalid');
  const { From, To, Body, MessageSid } = input.params;
  if (!From || !To || !Body || !MessageSid)
    throw new Error('Twilio inbound payload is incomplete');
  return {
    from: From,
    to: To,
    body: Body,
    messageSid: MessageSid,
    command: parseSmsCommand(Body),
  };
}
export function verifyTwilioStatusCallback(input: {
  url: string;
  params: Record<string, string>;
  signature: string;
  authToken: string;
}) {
  if (!verifyTwilioSignature(input))
    throw new Error('Twilio signature is invalid');
  const sid = input.params.MessageSid;
  const status = input.params.MessageStatus;
  if (!sid || !status) throw new Error('Twilio status callback is incomplete');
  return { providerId: sid, status, errorCode: input.params.ErrorCode ?? null };
}
