import { useCallback, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import { apiPost } from '../../api/client';

import {
  PaymentElementCheckout,
  assertPaymentQuote,
  type PaymentQuote,
  type PaymentSubmissionState,
} from './PaymentElementCheckout';

const intentSchema = z.strictObject({
  id: z.string().startsWith('pi_'),
  clientSecret: z.string().min(1),
  status: z.string().min(1),
  quote: z.strictObject({
    baseCents: z.number().int().nonnegative(),
    serviceFeeCents: z.number().int().nonnegative(),
    taxCents: z.number().int().nonnegative(),
    amountCents: z.number().int().positive(),
    applicationFeeCents: z.number().int().nonnegative(),
  }),
});

function stableKey(checkoutId: string, invoiceId: string): string {
  const storageKey = `athlentry.checkout-payment.${checkoutId}.${invoiceId}`;
  try {
    const previous = sessionStorage.getItem(storageKey);
    if (previous && z.uuid().safeParse(previous).success) return previous;
    const created = crypto.randomUUID();
    sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export function CheckoutPaymentScreen({
  orgId,
  checkoutId,
  invoiceId,
  publishableKey,
  quote,
  returnUrl,
  saveForAutopay = false,
  onSubmitted,
}: {
  orgId: string;
  checkoutId: string;
  invoiceId: string;
  publishableKey: string;
  quote: PaymentQuote;
  returnUrl: string;
  saveForAutopay?: boolean;
  onSubmitted: (state: PaymentSubmissionState) => void;
}): React.JSX.Element {
  const key = useMemo(
    () => stableKey(checkoutId, invoiceId),
    [checkoutId, invoiceId],
  );
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    setClientSecret(null);
    try {
      assertPaymentQuote(quote);
      const result = await apiPost(
        `/finance/orgs/${encodeURIComponent(orgId)}/checkout-payment-intents`,
        { checkoutId, invoiceId, saveForAutopay },
        intentSchema,
        key,
      );
      if (
        result.quote.amountCents !== quote.totalCents ||
        result.quote.serviceFeeCents !== quote.serviceFeeCents ||
        result.quote.taxCents !== quote.taxCents
      )
        throw new Error(
          'The payment amount changed. Refresh your checkout quote.',
        );
      setClientSecret(result.clientSecret);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Payment is unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [checkoutId, invoiceId, key, orgId, quote, saveForAutopay]);

  useEffect(() => {
    void load();
  }, [load]);
  if (loading) return <p role="status">Preparing secure payment…</p>;
  if (error || !clientSecret)
    return (
      <section className="money-panel">
        <p role="alert" className="money-error">
          {error || 'Payment is unavailable.'}
        </p>
        <button className="button" type="button" onClick={() => void load()}>
          Retry payment
        </button>
      </section>
    );
  return (
    <PaymentElementCheckout
      publishableKey={publishableKey}
      clientSecret={clientSecret}
      quote={quote}
      returnUrl={returnUrl}
      onSubmitted={onSubmitted}
    />
  );
}
