import { formatMoney } from '@shared/money';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Link, PageHeader } from '../../ui/primitives';
import { PortalShell } from '../PortalShell';
import { CheckoutPaymentScreen } from '../money/CheckoutPaymentScreen';
import type { PaymentSubmissionState } from '../money/PaymentElementCheckout';

import '../money/money.css';

const checkoutSchema = z.strictObject({
  checkoutId: z.uuid(),
  expiresAt: z.iso.datetime(),
  status: z.enum(['open', 'awaiting_payment', 'completed']),
  cart: z.strictObject({
    offerings: z.array(
      z.strictObject({
        lineId: z.uuid(),
        offeringId: z.uuid(),
        personId: z.uuid(),
        householdId: z.uuid(),
      }),
    ),
  }),
});
const policySchema = z.strictObject({
  terms: z.strictObject({
    policy: z.strictObject({
      rules: z.array(
        z.strictObject({
          throughDate: z.iso.date(),
          refundBps: z.number().int(),
        }),
      ),
      afterLastBps: z.number().int(),
      serviceFeeRefund: z.enum(['proportional', 'none']),
    }),
    approvalThresholdCents: z.number().int(),
    refundApplicationFee: z.boolean(),
  }),
  termsHash: z.string().regex(/^[0-9a-f]{64}$/),
  accepted: z.boolean(),
});
const quoteSchema = z.strictObject({
  checkoutId: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNumber: z.number().int().positive(),
  totalCents: z.number().int().positive(),
  chargeNowCents: z.number().int().positive(),
  serviceFeeCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  lines: z.array(
    z.strictObject({
      kind: z.string(),
      description: z.string(),
      amountCents: z.number().int(),
    }),
  ),
});
const configSchema = z.strictObject({
  publishableKey: z.string().startsWith('pk_test_'),
});
type Quote = z.output<typeof quoteSchema>;

function stableQuoteKey(checkoutId: string): string {
  const storageKey = `athlentry.registration.quote.${checkoutId}`;
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (saved && z.uuid().safeParse(saved).success) return saved;
    const created = crypto.randomUUID();
    sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export function CheckoutReviewScreen({
  orgId,
  checkoutId,
}: {
  orgId: string;
  checkoutId: string;
}): React.JSX.Element {
  const { i18n } = useTranslation();
  const [accepted, setAccepted] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [publishableKey, setPublishableKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState<PaymentSubmissionState | null>(
    null,
  );
  const base = `/registration/orgs/${encodeURIComponent(orgId)}/checkouts/${encodeURIComponent(checkoutId)}`;
  const checkout = useQuery({
    queryKey: ['registration', orgId, 'checkout', checkoutId],
    queryFn: () => apiGet(base, checkoutSchema),
  });
  const policy = useQuery({
    queryKey: ['registration', orgId, 'policy', checkoutId],
    queryFn: () => apiGet(`${base}/refund-terms`, policySchema),
  });
  const paymentQuote = useMemo(
    () =>
      quote
        ? {
            lines: quote.lines
              .filter(
                (line) => line.kind !== 'service_fee' && line.kind !== 'tax',
              )
              .map((line, index) => ({
                id: String(index),
                description: line.description,
                amountCents: line.amountCents,
              })),
            serviceFeeCents: quote.serviceFeeCents,
            taxCents: quote.taxCents,
            totalCents: quote.chargeNowCents,
          }
        : null,
    [quote],
  );
  const continueToPayment = async (): Promise<void> => {
    if (busy || !policy.data) return;
    setBusy(true);
    setError('');
    try {
      if (!policy.data.accepted) {
        if (!accepted) throw new Error('Accept the refund terms to continue.');
        await apiPost(
          `${base}/refund-terms/accept`,
          { termsHash: policy.data.termsHash },
          policySchema,
        );
        await policy.refetch();
      }
      const result = await apiPost(
        `${base}/quote`,
        {},
        quoteSchema,
        stableQuoteKey(checkoutId),
      );
      const config = await apiGet(
        '/finance/stripe-client-config',
        configSchema,
      );
      setQuote(result);
      setPublishableKey(config.publishableKey);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Checkout is unavailable.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <PortalShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="REGISTRATION"
          title="Review your registration"
          description="Check the refund terms and payment amount before paying."
        />
        <p>
          <Link to={`/portal/orgs/${orgId}/register`}>Back to programs</Link>
        </p>
        {(checkout.isLoading || policy.isLoading) && (
          <p role="status">Loading checkout…</p>
        )}
        {(checkout.error || policy.error) && (
          <p role="alert" className="money-error">
            Checkout is unavailable. Refresh the page.
          </p>
        )}
        {checkout.data?.status === 'completed' && (
          <section className="money-panel">
            <h2>Registration confirmed</h2>
            <p>Your organization has your registration.</p>
            <Link to={`/portal/orgs/${orgId}/money/invoices`}>
              View invoice
            </Link>
          </section>
        )}
        {checkout.data &&
          checkout.data.status !== 'completed' &&
          policy.data &&
          !quote && (
            <section className="money-panel">
              <h2>Refund terms</h2>
              <p>Review the policy that will be saved with this invoice.</p>
              <ul>
                {policy.data.terms.policy.rules.map((rule) => (
                  <li key={rule.throughDate}>
                    Through {rule.throughDate}: {rule.refundBps / 100}% of
                    eligible charges
                  </li>
                ))}
              </ul>
              <p>
                After the listed dates:{' '}
                {policy.data.terms.policy.afterLastBps / 100}% of eligible
                charges.
              </p>
              <p>
                Service fee refunds:{' '}
                {policy.data.terms.policy.serviceFeeRefund === 'proportional'
                  ? 'proportional'
                  : 'none'}
                .
              </p>
              {!policy.data.accepted && (
                <label>
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(event) => {
                      setAccepted(event.target.checked);
                    }}
                  />
                  I have read and accept these refund terms.
                </label>
              )}
              <button
                className="button"
                type="button"
                disabled={busy || (!policy.data.accepted && !accepted)}
                onClick={() => void continueToPayment()}
              >
                {busy ? 'Preparing checkout…' : 'Continue to payment'}
              </button>
            </section>
          )}
        {quote && paymentQuote && (
          <section aria-label="Payment quote">
            <p>
              Invoice #{quote.invoiceNumber}:{' '}
              {formatMoney(quote.totalCents, i18n.language)}
            </p>
            {submitted ? (
              <div className="money-panel" role="status">
                <h2>Payment submitted</h2>
                <p>
                  {submitted === 'processing'
                    ? 'Your payment is processing. Your invoice will update when it settles.'
                    : 'Your payment was submitted. Check the invoice for the latest confirmed status.'}
                </p>
                <Link to={`/portal/orgs/${orgId}/money/invoices`}>
                  View invoice and balance
                </Link>
              </div>
            ) : (
              <CheckoutPaymentScreen
                orgId={orgId}
                checkoutId={checkoutId}
                invoiceId={quote.invoiceId}
                publishableKey={publishableKey}
                quote={paymentQuote}
                returnUrl={window.location.href}
                onSubmitted={setSubmitted}
              />
            )}
          </section>
        )}
        {error && (
          <p role="alert" className="money-error">
            {error}
          </p>
        )}
      </main>
    </PortalShell>
  );
}
