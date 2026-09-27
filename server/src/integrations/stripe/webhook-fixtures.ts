import { handledStripeEventTypes } from './webhooks.js';

export type HandledStripeEventType = (typeof handledStripeEventTypes)[number];

const objectByPrefix: Record<string, string> = {
  payment_intent: 'payment_intent',
  charge: 'charge',
  setup_intent: 'setup_intent',
  payment_method: 'payment_method',
  account: 'account',
  payout: 'payout',
  customer: 'subscription',
  invoice: 'invoice',
};

/** Deterministic test-mode event fixtures for every finance webhook handler. */
export function stripeEventFixture(
  type: HandledStripeEventType,
  livemode = false,
) {
  const prefix = type.split('.')[0] ?? '';
  const object = type.startsWith('charge.refund.')
    ? 'refund'
    : type.startsWith('charge.dispute.')
      ? 'dispute'
      : objectByPrefix[prefix];
  if (!object) throw new Error(`No Stripe fixture object for ${type}`);
  return {
    id: `evt_${type.replaceAll('.', '_')}`,
    object: 'event' as const,
    type,
    created: 1_700_000_000,
    livemode,
    ...(type.startsWith('payout.') ? { account: 'acct_fixture' } : {}),
    data: { object: { id: `${object}_fixture`, object } },
  };
}
