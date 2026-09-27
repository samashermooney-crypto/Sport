import { Temporal } from '@js-temporal/polyfill';

export type CheckoutStatus =
  | 'open'
  | 'awaiting_payment'
  | 'completed'
  | 'expired'
  | 'abandoned'
  | 'failed';

export interface CheckoutState {
  status: CheckoutStatus;
  holdExpiresAt: string;
  processingStartedAt: string | null;
  retryExpiresAt: string | null;
}

export type CheckoutEvent =
  | { type: 'begin_payment'; at: string }
  | { type: 'payment_processing'; at: string }
  | { type: 'capacity_confirmed'; at: string }
  | { type: 'payment_failed'; at: string }
  | { type: 'retry_payment'; at: string }
  | { type: 'expire'; at: string }
  | { type: 'abandon'; at: string };

function compare(a: string, b: string): number {
  return Temporal.Instant.compare(
    Temporal.Instant.from(a),
    Temporal.Instant.from(b),
  );
}

/** State changes are applied only after the corresponding DB/Stripe action succeeds. */
export function transitionCheckout(
  state: CheckoutState,
  event: CheckoutEvent,
): CheckoutState {
  if (event.type === 'begin_payment' && state.status === 'open') {
    if (compare(event.at, state.holdExpiresAt) > 0)
      throw new Error('Capacity hold expired');
    return { ...state, status: 'awaiting_payment' };
  }
  if (
    event.type === 'payment_processing' &&
    state.status === 'awaiting_payment'
  ) {
    if (compare(event.at, state.holdExpiresAt) > 0)
      throw new Error('Payment started after hold expiry');
    return {
      ...state,
      processingStartedAt: state.processingStartedAt ?? event.at,
    };
  }
  if (
    event.type === 'capacity_confirmed' &&
    state.status === 'awaiting_payment'
  ) {
    return { ...state, status: 'completed', retryExpiresAt: null };
  }
  if (event.type === 'payment_failed' && state.status === 'awaiting_payment') {
    const retryExpiresAt =
      state.retryExpiresAt ??
      Temporal.Instant.from(event.at).add({ hours: 72 }).toString();
    return {
      ...state,
      status: 'failed',
      processingStartedAt: null,
      holdExpiresAt: retryExpiresAt,
      retryExpiresAt,
    };
  }
  if (event.type === 'retry_payment' && state.status === 'failed') {
    if (!state.retryExpiresAt || compare(event.at, state.retryExpiresAt) > 0) {
      throw new Error('Payment retry window expired');
    }
    return { ...state, status: 'awaiting_payment', processingStartedAt: null };
  }
  if (
    event.type === 'expire' &&
    (state.status === 'open' || state.status === 'failed')
  ) {
    const deadline =
      state.status === 'failed' ? state.retryExpiresAt : state.holdExpiresAt;
    if (!deadline || compare(event.at, deadline) < 0)
      throw new Error('Checkout has not expired');
    return { ...state, status: 'expired' };
  }
  if (event.type === 'abandon' && state.status === 'open') {
    return { ...state, status: 'abandoned' };
  }
  if (event.type === 'capacity_confirmed' && state.status === 'completed')
    return state;
  throw new Error(
    `Invalid checkout transition: ${state.status} -> ${event.type}`,
  );
}
