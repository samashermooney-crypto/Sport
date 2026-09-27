import { formatMoney } from '@shared/money';
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import type { StripeElementsOptions } from '@stripe/stripe-js';
import { useMemo, useState } from 'react';

import '../../console/money/money.css';
import './money.css';

export interface PaymentQuote {
  lines: readonly { id: string; description: string; amountCents: number }[];
  serviceFeeCents: number;
  taxCents: number;
  totalCents: number;
}

export type PaymentSubmissionState =
  'succeeded' | 'processing' | 'requires_action';

export function assertTestPublishableKey(key: string): void {
  if (!key.startsWith('pk_test_') || key.length <= 'pk_test_'.length) {
    throw new Error('Only Stripe test publishable keys are permitted');
  }
}

export function assertPaymentQuote(quote: PaymentQuote): void {
  const amounts = [
    ...quote.lines.map((line) => line.amountCents),
    quote.serviceFeeCents,
    quote.taxCents,
    quote.totalCents,
  ];
  if (amounts.some((amount) => !Number.isSafeInteger(amount))) {
    throw new Error('Payment quote contains non-integer cents');
  }
  if (quote.serviceFeeCents < 0 || quote.taxCents < 0 || quote.totalCents < 1) {
    throw new Error('Payment quote has invalid charges');
  }
  const computed =
    quote.lines.reduce((sum, line) => sum + BigInt(line.amountCents), 0n) +
    BigInt(quote.serviceFeeCents) +
    BigInt(quote.taxCents);
  if (computed !== BigInt(quote.totalCents)) {
    throw new Error('Payment quote total does not match its lines');
  }
}

function appearance(): NonNullable<StripeElementsOptions['appearance']> {
  const css = getComputedStyle(document.documentElement);
  return {
    theme: 'stripe',
    variables: {
      colorPrimary: css.getPropertyValue('--accent').trim(),
      colorText: css.getPropertyValue('--ink').trim(),
      colorDanger: css.getPropertyValue('--bad').trim(),
      fontFamily: css.getPropertyValue('--font-app').trim(),
      borderRadius: css.getPropertyValue('--radius-3').trim(),
    },
  };
}

function PaymentForm({
  quote,
  returnUrl,
  onSubmitted,
  paymentContext,
}: {
  quote: PaymentQuote;
  returnUrl: string;
  onSubmitted: (state: PaymentSubmissionState) => void;
  paymentContext: 'checkout' | 'installment';
}): React.JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<PaymentSubmissionState | null>(null);
  const [uncertain, setUncertain] = useState(false);

  async function submit(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!stripe || !elements || busy) return;
    const returnTarget = new URL(returnUrl, window.location.origin);
    if (returnTarget.origin !== window.location.origin) {
      setError('Payment return address is invalid.');
      return;
    }
    setBusy(true);
    setError('');
    const confirm = () =>
      stripe.confirmPayment({
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
        'Payment status is unknown. Check your balance before trying again.',
      );
      setBusy(false);
      return;
    }
    if (result.error) {
      setError(result.error.message ?? 'Payment could not be submitted.');
      setBusy(false);
      return;
    }
    const status = result.paymentIntent.status;
    if (
      status === 'succeeded' ||
      status === 'processing' ||
      status === 'requires_action'
    ) {
      setState(status);
      try {
        onSubmitted(status);
      } catch {
        setError(
          'Payment was submitted, but its status could not be refreshed. Check your balance before retrying.',
        );
      }
      return;
    }
    setError('Payment needs another method. Please try again.');
    setBusy(false);
  }

  return (
    <form className="money-panel" onSubmit={(event) => void submit(event)}>
      <h2>Review and pay</h2>
      <dl className="money-lines">
        {quote.lines.map((line) => (
          <div key={line.id}>
            <dt>{line.description}</dt>
            <dd>{formatMoney(line.amountCents, 'en-US')}</dd>
          </div>
        ))}
        {(paymentContext === 'checkout' || quote.serviceFeeCents > 0) && (
          <div>
            <dt>Service fee</dt>
            <dd>{formatMoney(quote.serviceFeeCents, 'en-US')}</dd>
          </div>
        )}
        {quote.taxCents > 0 && (
          <div>
            <dt>Tax</dt>
            <dd>{formatMoney(quote.taxCents, 'en-US')}</dd>
          </div>
        )}
        <div className="money-total">
          <dt>Total due now</dt>
          <dd>{formatMoney(quote.totalCents, 'en-US')}</dd>
        </div>
      </dl>
      <PaymentElement options={{ layout: 'tabs' }} />
      {error && (
        <p role="alert" className="money-error">
          {error}
        </p>
      )}
      {state && (
        <p role="status">
          {state === 'processing'
            ? 'Your bank payment is processing. Your balance will update after it clears.'
            : state === 'succeeded'
              ? paymentContext === 'installment'
                ? 'Stripe received your installment payment. Your balance will update after reconciliation.'
                : 'Stripe received your payment. We are confirming your registration.'
              : 'Additional authentication is required to complete payment.'}
        </p>
      )}
      {!state && !uncertain && (
        <button
          className="button"
          type="submit"
          disabled={!stripe || !elements || busy}
        >
          {busy
            ? 'Submitting payment…'
            : `Pay ${formatMoney(quote.totalCents, 'en-US')}`}
        </button>
      )}
    </form>
  );
}

export function PaymentElementCheckout({
  publishableKey,
  clientSecret,
  quote,
  returnUrl,
  onSubmitted,
  paymentContext = 'checkout',
}: {
  publishableKey: string;
  clientSecret: string;
  quote: PaymentQuote;
  returnUrl: string;
  onSubmitted: (state: PaymentSubmissionState) => void;
  paymentContext?: 'checkout' | 'installment';
}): React.JSX.Element {
  assertTestPublishableKey(publishableKey);
  assertPaymentQuote(quote);
  const stripe = useMemo(() => loadStripe(publishableKey), [publishableKey]);
  const options = useMemo<StripeElementsOptions>(
    () => ({
      clientSecret,
      appearance: appearance(),
    }),
    [clientSecret],
  );
  return (
    <Elements key={clientSecret} stripe={stripe} options={options}>
      <PaymentForm
        quote={quote}
        returnUrl={returnUrl}
        onSubmitted={onSubmitted}
        paymentContext={paymentContext}
      />
    </Elements>
  );
}
