import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { stripeEventFixture } from './webhook-fixtures.js';
import {
  handledStripeEventTypes,
  isHandledStripeEvent,
  verifyStripeWebhook,
} from './webhooks.js';

const secret = 'whsec_test_fixture';
const now = 1_700_000_000;

function event(type: string, livemode = false): Buffer {
  if (!isHandledStripeEvent(type))
    throw new Error('Unhandled event fixture requested');
  return Buffer.from(JSON.stringify(stripeEventFixture(type, livemode)));
}

function signature(body: Buffer, timestamp = now): string {
  const digest = createHmac('sha256', secret)
    .update(`${String(timestamp)}.`)
    .update(body)
    .digest('hex');
  return `t=${String(timestamp)},v1=${digest}`;
}

describe('Stripe webhooks', () => {
  it.each(handledStripeEventTypes)('verifies and parses %s', (type) => {
    const body = event(type);
    expect(verifyStripeWebhook(body, signature(body), secret, now).type).toBe(
      type,
    );
    expect(isHandledStripeEvent(type)).toBe(true);
  });

  it('rejects a changed byte, old timestamp, and live event', () => {
    const body = event('payment_intent.succeeded');
    expect(() =>
      verifyStripeWebhook(
        Buffer.concat([body, Buffer.from(' ')]),
        signature(body),
        secret,
        now,
      ),
    ).toThrow();
    expect(() =>
      verifyStripeWebhook(body, signature(body, now - 301), secret, now),
    ).toThrow();
    const live = event('payment_intent.succeeded', true);
    expect(() =>
      verifyStripeWebhook(live, signature(live), secret, now),
    ).toThrow('Live Stripe events');
  });

  it('accepts a rotated secret signature alongside another v1', () => {
    const body = event('account.updated');
    const header = `${signature(body)},v1=${'0'.repeat(64)}`;
    expect(verifyStripeWebhook(body, header, secret, now).type).toBe(
      'account.updated',
    );
  });
});
