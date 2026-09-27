import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet } from '../../api/client';

import './money.css';

const receiptSchema = z.strictObject({
  paymentId: z.uuid(),
  amountCents: z.number().int().positive(),
  method: z.string(),
  succeededAt: z.iso.datetime(),
  receiptNumber: z.number().int().positive().nullable(),
  invoiceNumbers: z.array(z.number().int().positive()),
});
const listSchema = z.strictObject({
  receipts: z.array(receiptSchema),
  nextCursor: z.string().nullable(),
});
type Receipt = z.output<typeof receiptSchema>;
const money = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
});

export function ReceiptsScreen({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}): React.JSX.Element {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(
    async (next: string | null): Promise<void> => {
      setLoading(true);
      setError('');
      try {
        const path = `/finance/orgs/${encodeURIComponent(orgId)}/me/receipts`;
        const response = await apiGet(
          next ? `${path}?cursor=${encodeURIComponent(next)}` : path,
          listSchema,
        );
        setReceipts((current) =>
          next ? [...current, ...response.receipts] : response.receipts,
        );
        setCursor(response.nextCursor);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : 'Receipts are unavailable.',
        );
      } finally {
        setLoading(false);
      }
    },
    [orgId],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  return (
    <section className="money-panel" aria-label={`${orgName} receipts`}>
      <h2>{orgName} receipts</h2>
      {loading ? <p role="status">Loading receipts…</p> : null}
      {error ? (
        <p role="alert" className="money-error">
          {error}
        </p>
      ) : null}
      {!loading && error ? (
        <button
          className="button"
          type="button"
          onClick={() => {
            void load(cursor);
          }}
        >
          Retry
        </button>
      ) : null}
      {!loading && !error && receipts.length === 0 ? (
        <p>No receipts yet.</p>
      ) : null}
      {receipts.length > 0 ? (
        <ul className="money-autopay-list">
          {receipts.map((receipt) => (
            <li key={receipt.paymentId}>
              <div>
                <strong>
                  {receipt.receiptNumber
                    ? `Receipt #${String(receipt.receiptNumber)}`
                    : 'Payment receipt'}
                </strong>
                <span>
                  {new Date(receipt.succeededAt).toLocaleDateString()} ·{' '}
                  {receipt.method}
                </span>
                <span>
                  Invoice{' '}
                  {receipt.invoiceNumbers
                    .map((number) => `#${String(number)}`)
                    .join(', ')}
                </span>
                <span>{money.format(receipt.amountCents / 100)}</span>
              </div>
              <a
                className="button money-document-link"
                href={`/api/v1/finance/orgs/${encodeURIComponent(orgId)}/me/payments/${receipt.paymentId}/receipt.pdf`}
              >
                Download receipt PDF
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {!loading && !error && cursor ? (
        <button
          className="button"
          type="button"
          onClick={() => {
            void load(cursor);
          }}
        >
          Load more receipts
        </button>
      ) : null}
    </section>
  );
}
