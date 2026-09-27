import { describe, expect, it } from 'vitest';

import { transitionCheckout, type CheckoutState } from './state.js';

const open: CheckoutState = {
  status: 'open',
  holdExpiresAt: '2026-09-26T20:20:00Z',
  processingStartedAt: null,
  retryExpiresAt: null,
};

describe('checkout state machine', () => {
  it('freezes checkout at payment and keeps an on-time processing hold', () => {
    const awaiting = transitionCheckout(open, {
      type: 'begin_payment',
      at: '2026-09-26T20:10:00Z',
    });
    const processing = transitionCheckout(awaiting, {
      type: 'payment_processing',
      at: '2026-09-26T20:19:00Z',
    });
    expect(processing.processingStartedAt).toBe('2026-09-26T20:19:00Z');
    expect(() =>
      transitionCheckout(processing, {
        type: 'expire',
        at: '2026-09-26T20:21:00Z',
      }),
    ).toThrow();
    const completed = transitionCheckout(processing, {
      type: 'capacity_confirmed',
      at: '2026-09-26T20:25:00Z',
    });
    expect(completed.status).toBe('completed');
    expect(
      transitionCheckout(completed, {
        type: 'capacity_confirmed',
        at: '2026-09-26T20:26:00Z',
      }),
    ).toBe(completed);
  });

  it('gives failed deposits a 72-hour retry window then expires', () => {
    const awaiting = transitionCheckout(open, {
      type: 'begin_payment',
      at: '2026-09-26T20:10:00Z',
    });
    const failed = transitionCheckout(awaiting, {
      type: 'payment_failed',
      at: '2026-09-26T20:15:00Z',
    });
    expect(failed.retryExpiresAt).toBe('2026-09-29T20:15:00Z');
    const retried = transitionCheckout(failed, {
      type: 'retry_payment',
      at: '2026-09-28T20:15:00Z',
    });
    expect(retried.status).toBe('awaiting_payment');
    expect(
      transitionCheckout(retried, {
        type: 'payment_processing',
        at: '2026-09-28T20:16:00Z',
      }).processingStartedAt,
    ).toBe('2026-09-28T20:16:00Z');
    expect(
      transitionCheckout(retried, {
        type: 'payment_failed',
        at: '2026-09-28T20:17:00Z',
      }).retryExpiresAt,
    ).toBe(failed.retryExpiresAt);
    expect(
      transitionCheckout(failed, { type: 'expire', at: '2026-09-29T20:15:00Z' })
        .status,
    ).toBe('expired');
    expect(() =>
      transitionCheckout(failed, {
        type: 'retry_payment',
        at: '2026-09-29T20:15:01Z',
      }),
    ).toThrow();
  });

  it('rejects late payment start and premature expiry', () => {
    expect(() =>
      transitionCheckout(open, {
        type: 'begin_payment',
        at: '2026-09-26T20:21:00Z',
      }),
    ).toThrow();
    expect(() =>
      transitionCheckout(open, { type: 'expire', at: '2026-09-26T20:19:00Z' }),
    ).toThrow();
  });
});
