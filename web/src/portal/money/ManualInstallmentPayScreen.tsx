import { formatMoney } from '@shared/money';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';

import {
  PaymentElementCheckout,
  type PaymentSubmissionState,
} from './PaymentElementCheckout';

import './money.css';

const listSchema = z.strictObject({
  installments: z.array(
    z.strictObject({
      id: z.uuid(),
      invoiceId: z.uuid(),
      invoiceNumber: z.number().int().positive(),
      dueOn: z.iso.date(),
      outstandingCents: z.number().int().positive(),
      status: z.enum(['scheduled', 'failed']),
    }),
  ),
});
const intentSchema = z.strictObject({
  id: z.string().startsWith('pi_'),
  clientSecret: z.string().min(1),
  status: z.string().min(1),
  amountCents: z.number().int().positive(),
  applicationFeeCents: z.number().int().nonnegative(),
});
const configSchema = z.strictObject({
  publishableKey: z.string().startsWith('pk_test_'),
});
type Installment = z.output<typeof listSchema>['installments'][number];

function paymentKey(orgId: string, installmentId: string): string {
  const storageKey = `athlentry.manual-installment.${orgId}.${installmentId}`;
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
function clearPaymentKey(orgId: string, installmentId: string): void {
  try {
    sessionStorage.removeItem(
      `athlentry.manual-installment.${orgId}.${installmentId}`,
    );
  } catch {
    /* session storage may be disabled */
  }
}

export function ManualInstallmentPayScreen({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [publishableKey, setPublishableKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const base = `/finance/orgs/${encodeURIComponent(orgId)}/me/installments`;
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await apiGet(base, listSchema);
      setInstallments(result.installments);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Installments are unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [base]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const selected = installments.find((item) => item.id === selectedId);
  const start = async (): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const config = await apiGet(
        '/finance/stripe-client-config',
        configSchema,
      );
      const intent = await apiPost(
        `${base}/${selected.id}/payment-intents`,
        {},
        intentSchema,
        paymentKey(orgId, selected.id),
      );
      if (intent.amountCents !== selected.outstandingCents)
        throw new Error('Installment amount changed. Refresh before paying.');
      setPublishableKey(config.publishableKey);
      setClientSecret(intent.clientSecret);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Payment could not start.';
      if (message.includes('start a new attempt'))
        clearPaymentKey(orgId, selected.id);
      setError(message);
    } finally {
      setBusy(false);
    }
  };
  const submitted = (state: PaymentSubmissionState): void => {
    setNotice(
      state === 'processing'
        ? 'Your payment is processing. The balance will update after it clears.'
        : 'Payment submitted. Check your invoice balance for the confirmed result.',
    );
    void refresh();
  };
  return (
    <section className="money-panel" aria-label="Pay installments">
      <h2>Pay an installment</h2>
      {loading ? <p role="status">Loading installments…</p> : null}
      {error ? (
        <p role="alert" className="money-error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!loading && error && installments.length === 0 ? (
        <button
          className="button"
          type="button"
          onClick={() => {
            void refresh();
          }}
        >
          Retry
        </button>
      ) : null}
      {!loading && installments.length === 0 && !error ? (
        <p>No unpaid installments are available.</p>
      ) : null}
      {installments.length > 0 ? (
        <>
          <label htmlFor="pay-installment">Installment</label>
          <select
            id="pay-installment"
            value={selectedId}
            disabled={Boolean(clientSecret)}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setClientSecret(null);
              setPublishableKey(null);
              setError('');
            }}
          >
            <option value="">Choose an installment</option>
            {installments.map((item) => (
              <option key={item.id} value={item.id}>
                Invoice #{item.invoiceNumber} — due {item.dueOn} —{' '}
                {formatMoney(item.outstandingCents, 'en-US')}
              </option>
            ))}
          </select>
          {selected ? (
            <p>
              Due now: {formatMoney(selected.outstandingCents, 'en-US')},
              including any service fee shown on{' '}
              <a
                href={`/api/v1/finance/orgs/${encodeURIComponent(orgId)}/me/invoices/${selected.invoiceId}/pdf`}
              >
                invoice #{selected.invoiceNumber}
              </a>
              .
            </p>
          ) : null}
          {selected && !clientSecret ? (
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => {
                void start();
              }}
            >
              {busy ? 'Preparing payment…' : 'Continue to secure payment'}
            </button>
          ) : null}
          {selected && clientSecret && publishableKey ? (
            <PaymentElementCheckout
              publishableKey={publishableKey}
              clientSecret={clientSecret}
              quote={{
                lines: [
                  {
                    id: selected.id,
                    description: 'Installment due (including invoice fees)',
                    amountCents: selected.outstandingCents,
                  },
                ],
                serviceFeeCents: 0,
                taxCents: 0,
                totalCents: selected.outstandingCents,
              }}
              returnUrl={`${window.location.origin}/portal/orgs/${orgId}/money/installments`}
              paymentContext="installment"
              onSubmitted={submitted}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
