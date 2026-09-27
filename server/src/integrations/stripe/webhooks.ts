import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

export const handledStripeEventTypes = [
  'payment_intent.succeeded',
  'payment_intent.processing',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.requires_action',
  'charge.refunded',
  'charge.refund.updated',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
  'setup_intent.succeeded',
  'payment_method.detached',
  'account.updated',
  'payout.created',
  'payout.paid',
  'payout.failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.updated',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
] as const;
export type HandledStripeEventType = (typeof handledStripeEventTypes)[number];

const eventSchema = z.object({
  id: z.string().startsWith('evt_'),
  object: z.literal('event'),
  type: z.string(),
  account: z.string().startsWith('acct_').optional(),
  livemode: z.boolean(),
  created: z.number().int().nonnegative(),
  data: z.object({
    object: z.looseObject({ id: z.string(), object: z.string() }),
  }),
});

export type StripeWebhookEvent = z.infer<typeof eventSchema>;

export class StripeWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeWebhookError';
  }
}

export function parseStripeWebhookEvent(payload: unknown): StripeWebhookEvent {
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success)
    throw new StripeWebhookError('Invalid Stripe webhook event');
  if (parsed.data.livemode)
    throw new StripeWebhookError('Live Stripe events are forbidden');
  return parsed.data;
}

function signatureParts(header: string): {
  timestamp: number;
  signatures: Buffer[];
} {
  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
  for (const entry of header.split(',')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(Buffer.from(value, 'hex'));
    }
  }
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) {
    throw new StripeWebhookError('Invalid Stripe signature header');
  }
  return { timestamp: timestamp as number, signatures };
}

/** Verify the exact request bytes before JSON parsing. The secret is endpoint-specific. */
export function verifyStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string,
  endpointSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): StripeWebhookEvent {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new StripeWebhookError('Raw Stripe webhook body is required');
  }
  if (!endpointSecret.startsWith('whsec_')) {
    throw new StripeWebhookError('Invalid Stripe webhook endpoint secret');
  }
  const { timestamp, signatures } = signatureParts(signatureHeader);
  if (Math.abs(nowSeconds - timestamp) > 300) {
    throw new StripeWebhookError(
      'Stripe webhook timestamp is outside tolerance',
    );
  }
  const expected = createHmac('sha256', endpointSecret)
    .update(`${String(timestamp)}.`)
    .update(rawBody)
    .digest();
  if (!signatures.some((signature) => timingSafeEqual(expected, signature))) {
    throw new StripeWebhookError('Invalid Stripe webhook signature');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    throw new StripeWebhookError('Invalid Stripe webhook JSON');
  }
  return parseStripeWebhookEvent(payload);
}

export function isHandledStripeEvent(
  type: string,
): type is (typeof handledStripeEventTypes)[number] {
  return (handledStripeEventTypes as readonly string[]).includes(type);
}
