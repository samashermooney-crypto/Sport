import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import type { StripeElementsOptions } from '@stripe/stripe-js';
import { useMemo, useState } from 'react';

import { assertTestPublishableKey } from './PaymentElementCheckout';

function SetupForm({
  returnUrl,
  onSaved,
}: {
  returnUrl: string;
  onSaved: (status: 'succeeded' | 'processing') => void;
}): React.JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  async function submit(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!stripe || !elements || busy || uncertain) return;
    const returnTarget = new URL(returnUrl, window.location.origin);
    if (returnTarget.origin !== window.location.origin) {
      setError('Payment method return address is invalid.');
      return;
    }
    setBusy(true);
    setError('');
    const confirm = () =>
      stripe.confirmSetup({
        elements,
        confirmParams: { return_url: returnTarget.toString() },
        redirect: 'if_required',
      });
    let result: Awaited<ReturnType<typeof confirm>>;
    try {
      result = await confirm();
    } catch {
      setUncertain(true);
      setError(
        'Method status is unknown. Refresh saved methods before trying again.',
      );
      setBusy(false);
      return;
    }
    if (result.error) {
      setError(result.error.message ?? 'Payment method could not be saved.');
      setBusy(false);
      return;
    }
    if (
      result.setupIntent.status === 'succeeded' ||
      result.setupIntent.status === 'processing'
    ) {
      onSaved(result.setupIntent.status);
      return;
    }
    setError('Payment method needs another step. Please try again.');
    setBusy(false);
  }
  return (
    <form className="money-panel" onSubmit={(event) => void submit(event)}>
      <h2>Save a payment method</h2>
      <PaymentElement options={{ layout: 'tabs' }} />
      {error ? (
        <p className="money-error" role="alert">
          {error}
        </p>
      ) : null}
      {!uncertain ? (
        <button
          className="button"
          type="submit"
          disabled={!stripe || !elements || busy}
        >
          {busy ? 'Saving…' : 'Save payment method'}
        </button>
      ) : null}
    </form>
  );
}

export function SetupMethodElement({
  publishableKey,
  clientSecret,
  returnUrl,
  onSaved,
}: {
  publishableKey: string;
  clientSecret: string;
  returnUrl: string;
  onSaved: (status: 'succeeded' | 'processing') => void;
}): React.JSX.Element {
  assertTestPublishableKey(publishableKey);
  const stripe = useMemo(() => loadStripe(publishableKey), [publishableKey]);
  const options = useMemo<StripeElementsOptions>(() => {
    const css = getComputedStyle(document.documentElement);
    return {
      clientSecret,
      appearance: {
        theme: 'stripe',
        variables: {
          colorPrimary: css.getPropertyValue('--accent').trim(),
          colorText: css.getPropertyValue('--ink').trim(),
          colorDanger: css.getPropertyValue('--bad').trim(),
          fontFamily: css.getPropertyValue('--font-app').trim(),
          borderRadius: css.getPropertyValue('--radius-3').trim(),
        },
      },
    };
  }, [clientSecret]);
  return (
    <Elements key={clientSecret} stripe={stripe} options={options}>
      <SetupForm returnUrl={returnUrl} onSaved={onSaved} />
    </Elements>
  );
}
