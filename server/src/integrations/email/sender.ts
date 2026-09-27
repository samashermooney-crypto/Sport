import { createHmac, timingSafeEqual } from 'node:crypto';

import nodemailer from 'nodemailer';

export interface EmailAttachment {
  filename: string;
  content: string | Uint8Array;
  contentType?: string;
  contentId?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional for backward compatibility with auth messages created before HTML templates. */
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
  /** Security messages must never receive campaign tracking. */
  kind?: 'security' | 'transactional' | 'campaign';
  idempotencyKey?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ providerId: string }>;
}

export class FakeEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];

  send(message: EmailMessage): Promise<{ providerId: string }> {
    this.messages.push(message);
    return Promise.resolve({
      providerId: `fake-email-${String(this.messages.length)}`,
    });
  }
}

export function createMailpitEmailSender(
  options: {
    host?: string;
    port?: number;
  } = {},
): EmailSender {
  const port = options.port ?? mailpitSmtpPort();
  const transport = nodemailer.createTransport({
    host: options.host ?? '127.0.0.1',
    port,
    secure: false,
  });
  return {
    async send(message) {
      const result = await transport.sendMail({
        from: 'Athlentry Preview <preview@athlentry.invalid>',
        ...message,
        attachments: message.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content:
            typeof attachment.content === 'string'
              ? attachment.content
              : Buffer.from(attachment.content),
          contentType: attachment.contentType,
          cid: attachment.contentId,
        })),
      });
      return { providerId: result.messageId };
    },
  };
}

export function mailpitSmtpPort(
  value = process.env.ATHLENTRY_MAILPIT_SMTP_PORT,
): number {
  const port = value === undefined || value === '' ? 1025 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('ATHLENTRY_MAILPIT_SMTP_PORT must be a valid TCP port');
  return port;
}

export function createResendEmailSender(options: {
  apiKey: string;
  from: string;
  /** Use a separate domain configured with click/open tracking enabled. */
  campaignFrom?: string;
  fetch?: typeof fetch;
}): EmailSender {
  if (!options.apiKey || !options.from)
    throw new Error('Resend configuration is incomplete');
  if (
    options.campaignFrom &&
    emailDomain(options.campaignFrom) === emailDomain(options.from)
  ) {
    throw new Error(
      'Campaign tracking requires a separate sending domain from transactional mail',
    );
  }
  const fetcher = options.fetch ?? fetch;
  return {
    async send(message) {
      if (message.kind === 'campaign' && !options.campaignFrom)
        throw new Error(
          'A dedicated tracked campaign sender is not configured',
        );
      const response = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          ...(message.idempotencyKey
            ? { 'Idempotency-Key': message.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          from:
            message.kind === 'campaign'
              ? (options.campaignFrom ?? options.from)
              : options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
          ...(message.attachments
            ? {
                attachments: message.attachments.map((a) => ({
                  filename: a.filename,
                  content:
                    typeof a.content === 'string'
                      ? a.content
                      : Buffer.from(a.content).toString('base64'),
                  ...(a.contentType ? { content_type: a.contentType } : {}),
                })),
              }
            : {}),
          ...(message.kind === 'campaign'
            ? { tags: [{ name: 'category', value: 'campaign' }] }
            : {}),
        }),
      });
      if (!response.ok)
        throw new Error(
          `Resend request failed with HTTP ${String(response.status)}`,
        );
      const result: unknown = await response.json();
      const providerId =
        result &&
        typeof result === 'object' &&
        'id' in result &&
        typeof result.id === 'string'
          ? result.id
          : undefined;
      if (!providerId)
        throw new Error('Resend response did not include a message ID');
      return { providerId };
    },
  };
}

function emailDomain(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  const address = (match?.[1] ?? sender).trim();
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

export interface ResendWebhookEvent {
  type:
    | 'email.delivered'
    | 'email.bounced'
    | 'email.complained'
    | 'email.opened'
    | 'email.clicked';
  data: {
    email_id: string;
    to?: string[];
    created_at?: string;
    [key: string]: unknown;
  };
}

/** Svix-compatible HMAC verifier. The caller supplies raw request bytes and headers. */
export function verifyResendWebhook(input: {
  rawBody: string | Uint8Array;
  id: string;
  timestamp: string;
  signature: string;
  secret: string;
  now?: number;
}): ResendWebhookEvent {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300)
    throw new Error('Webhook timestamp is invalid or expired');
  const secret = input.secret.startsWith('whsec_')
    ? Buffer.from(input.secret.slice(6), 'base64')
    : Buffer.from(input.secret, 'base64');
  const signed = `${input.id}.${input.timestamp}.${Buffer.from(input.rawBody).toString()}`;
  const expected = createHmac('sha256', secret).update(signed).digest('base64');
  const candidates = input.signature
    .split(' ')
    .map((part) => part.split(',', 2))
    .filter(([version]) => version === 'v1')
    .map(([, sig]) => sig ?? '');
  const valid = candidates.some((candidate) => {
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!valid) throw new Error('Webhook signature is invalid');
  const parsed: unknown = JSON.parse(Buffer.from(input.rawBody).toString());
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('type' in parsed) ||
    !('data' in parsed)
  )
    throw new Error('Webhook payload is invalid');
  const event = parsed as { type?: unknown; data?: unknown };
  const allowed = new Set([
    'email.delivered',
    'email.bounced',
    'email.complained',
    'email.opened',
    'email.clicked',
  ]);
  if (
    typeof event.type !== 'string' ||
    !allowed.has(event.type) ||
    !event.data ||
    typeof event.data !== 'object'
  )
    throw new Error('Webhook event type is invalid');
  const data = event.data as { email_id?: unknown };
  if (typeof data.email_id !== 'string' || !data.email_id)
    throw new Error('Webhook event payload is invalid');
  return parsed as ResendWebhookEvent;
}
