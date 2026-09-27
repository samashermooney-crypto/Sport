import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet } from '../../api/client';

import './money.css';

const invoiceSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  status: z.enum([
    'open',
    'paid',
    'partially_paid',
    'past_due',
    'void',
    'uncollectible',
  ]),
  source: z.string(),
  issuedAt: z.iso.datetime().nullable(),
  dueOn: z.iso.date().nullable(),
  totalCents: z.number().int().nonnegative(),
  paidCents: z.number().int().nonnegative(),
  refundedCents: z.number().int().nonnegative(),
  creditAppliedCents: z.number().int().nonnegative(),
  balanceCents: z.number().int().nonnegative().nullable(),
});
const feedSchema = z.strictObject({
  invoices: z.array(invoiceSchema),
  nextBeforeNumber: z.number().int().positive().nullable(),
});
type Invoice = z.infer<typeof invoiceSchema>;

const dollars = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
});
const money = (cents: number): string => dollars.format(cents / 100);

export function InvoiceBalanceScreen({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}): React.JSX.Element {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [nextBeforeNumber, setNextBeforeNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (beforeNumber: number | null): Promise<void> => {
      if (beforeNumber === null) {
        setLoading(true);
        setInvoices([]);
        setNextBeforeNumber(null);
      } else setLoadingMore(true);
      setError('');
      try {
        const path = `/finance/orgs/${encodeURIComponent(orgId)}/me/invoices`;
        const query =
          beforeNumber === null ? '' : `?beforeNumber=${String(beforeNumber)}`;
        const page = await apiGet(`${path}${query}`, feedSchema);
        setInvoices((current) =>
          beforeNumber === null
            ? page.invoices
            : [...current, ...page.invoices],
        );
        setNextBeforeNumber(page.nextBeforeNumber);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : 'Invoices are unavailable.',
        );
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [orgId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <section className="money-panel" aria-label={`${orgName} invoices`}>
      <h2>{orgName} invoices</h2>
      {loading ? <p role="status">Loading invoices…</p> : null}
      {error ? (
        <p role="alert" className="money-error">
          {error}
        </p>
      ) : null}
      {!loading && error ? (
        <button
          className="button"
          type="button"
          onClick={() => void load(nextBeforeNumber)}
        >
          Retry
        </button>
      ) : null}
      {!loading && !error && invoices.length === 0 ? (
        <p>No invoices yet.</p>
      ) : null}
      {invoices.length > 0 ? (
        <ul className="money-invoices">
          {invoices.map((invoice) => (
            <li key={invoice.id}>
              <div className="money-invoice-heading">
                <strong>Invoice #{invoice.number}</strong>
                <span>{invoice.status.replaceAll('_', ' ')}</span>
              </div>
              <dl className="money-lines">
                <div>
                  <dt>Total</dt>
                  <dd>{money(invoice.totalCents)}</dd>
                </div>
                <div>
                  <dt>Balance</dt>
                  <dd className="money-total">
                    {invoice.balanceCents === null
                      ? 'Pending'
                      : money(invoice.balanceCents)}
                  </dd>
                </div>
                {invoice.dueOn ? (
                  <div>
                    <dt>Due</dt>
                    <dd>{invoice.dueOn}</dd>
                  </div>
                ) : null}
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
      {!loading && !error && nextBeforeNumber !== null ? (
        <button
          className="button"
          type="button"
          disabled={loadingMore}
          onClick={() => void load(nextBeforeNumber)}
        >
          {loadingMore ? 'Loading…' : 'Load more invoices'}
        </button>
      ) : null}
    </section>
  );
}
