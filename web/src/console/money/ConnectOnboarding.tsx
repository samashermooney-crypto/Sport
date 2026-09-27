import { useState } from 'react';

import './money.css';

export interface ConnectAccountView {
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsDue: readonly string[];
}

export interface ConnectOnboardingActions {
  createAccount: () => Promise<{ url: string }>;
  continueOnboarding: () => Promise<{ url: string }>;
  openDashboard: () => Promise<{ url: string }>;
}

export function assertStripeDestination(url: string): void {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    !target.hostname.endsWith('.stripe.com')
  ) {
    throw new Error('Stripe returned an invalid destination.');
  }
}

export function ConnectOnboarding({
  account,
  actions,
  navigate = (url: string) => {
    window.location.assign(url);
  },
}: {
  account: ConnectAccountView;
  actions: ConnectOnboardingActions;
  navigate?: (url: string) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(action: () => Promise<{ url: string }>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { url } = await action();
      assertStripeDestination(url);
      navigate(url);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Stripe connection failed.',
      );
      setBusy(false);
    }
  }

  const ready = account.chargesEnabled && account.payoutsEnabled;
  return (
    <section className="money-panel" aria-labelledby="connect-heading">
      <h2 id="connect-heading">Stripe payments</h2>
      <p>
        {ready
          ? 'Payments and payouts are enabled.'
          : account.stripeAccountId
            ? 'Finish the secure Stripe setup to accept payments.'
            : 'Connect a Stripe Express account to accept payments.'}
      </p>
      {account.stripeAccountId &&
        !ready &&
        account.requirementsDue.length > 0 && (
          <p>
            {account.requirementsDue.length} Stripe requirement
            {account.requirementsDue.length === 1 ? '' : 's'} remain.
          </p>
        )}
      {error && (
        <p role="alert" className="money-error">
          {error}
        </p>
      )}
      {ready ? (
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => void run(actions.openDashboard)}
        >
          Open Stripe dashboard
        </button>
      ) : account.stripeAccountId ? (
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => void run(actions.continueOnboarding)}
        >
          Continue Stripe setup
        </button>
      ) : (
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => void run(actions.createAccount)}
        >
          Connect Stripe
        </button>
      )}
    </section>
  );
}
