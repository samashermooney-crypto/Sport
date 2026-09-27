import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';

const invoiceSchema = z.object({
  id: z.uuid(),
  number: z.number().int().positive(),
  balanceCents: z.number().int().nonnegative().nullable(),
  status: z.string(),
});
const invoicePageSchema = z.object({
  invoices: z.array(invoiceSchema),
  nextBeforeNumber: z.number().int().positive().nullable(),
});
const appliedSchema = z.strictObject({ applied: z.literal(true) });
type Invoice = z.output<typeof invoiceSchema>;

const currency = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
});
const money = (cents: number): string => currency.format(cents / 100);

function stableApplyKey(scope: string): string {
  const storageKey = `athlentry.credit-apply:${scope}`;
  try {
    const current = sessionStorage.getItem(storageKey);
    if (current && z.uuid().safeParse(current).success) return current;
    const created = crypto.randomUUID();
    sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function clearApplyKey(scope: string): void {
  try {
    sessionStorage.removeItem(`athlentry.credit-apply:${scope}`);
  } catch {
    /* storage may be unavailable */
  }
}

export function CreditApplyPanel({
  orgId,
  accountBalanceCents,
  householdBalances,
  onApplied,
}: {
  orgId: string;
  accountBalanceCents: number;
  householdBalances: {
    householdId: string;
    householdName: string;
    balanceCents: number;
  }[];
  onApplied: () => void;
}): React.JSX.Element {
  const sources = [
    ...(accountBalanceCents > 0
      ? [
          {
            key: 'account',
            label: 'Your credit',
            amountCents: accountBalanceCents,
          },
        ]
      : []),
    ...householdBalances
      .filter((item) => item.balanceCents > 0)
      .map((item) => ({
        key: `household:${item.householdId}`,
        label: item.householdName,
        amountCents: item.balanceCents,
      })),
  ];
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [nextBeforeNumber, setNextBeforeNumber] = useState<number | null>(null);
  const [sourceKey, setSourceKey] = useState(sources[0]?.key ?? '');
  const [invoiceId, setInvoiceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(
    async (before: number | null): Promise<void> => {
      setLoading(true);
      setError('');
      try {
        const path = `/finance/orgs/${encodeURIComponent(orgId)}/me/invoices`;
        const page = await apiGet(
          before === null ? path : `${path}?beforeNumber=${String(before)}`,
          invoicePageSchema,
        );
        const payable = page.invoices.filter(
          (invoice) =>
            invoice.balanceCents !== null &&
            invoice.balanceCents > 0 &&
            ['open', 'partially_paid', 'past_due'].includes(invoice.status),
        );
        setInvoices((current) =>
          before === null ? payable : [...current, ...payable],
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
      }
    },
    [orgId],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  const source = sources.find((item) => item.key === sourceKey);
  const invoice = invoices.find((item) => item.id === invoiceId);
  const amountCents =
    source && invoice?.balanceCents
      ? Math.min(source.amountCents, invoice.balanceCents)
      : 0;
  const apply = async (): Promise<void> => {
    if (!source || !invoice || amountCents < 1) return;
    const recipient =
      source.key === 'account'
        ? { kind: 'account' }
        : {
            kind: 'household',
            householdId: source.key.slice('household:'.length),
          };
    const scope = `${orgId}:${invoice.id}:${source.key}:${String(amountCents)}`;
    setBusy(true);
    setError('');
    try {
      await apiPost(
        `/finance/orgs/${encodeURIComponent(orgId)}/me/credits/apply`,
        { recipient, invoiceId: invoice.id, amountCents },
        appliedSchema,
        stableApplyKey(scope),
      );
      clearApplyKey(scope);
      onApplied();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Credit could not be applied.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="money-credit-apply">
      <h3>Apply credit to an invoice</h3>
      {error ? (
        <p role="alert" className="money-error">
          {error}
        </p>
      ) : null}
      {loading ? <p role="status">Loading payable invoices…</p> : null}
      {!loading && invoices.length === 0 ? <p>No payable invoices.</p> : null}
      {invoices.length > 0 ? (
        <>
          <label htmlFor="credit-source">Credit source</label>
          <select
            id="credit-source"
            value={sourceKey}
            onChange={(event) => {
              setSourceKey(event.target.value);
            }}
          >
            {sources.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label} · {money(item.amountCents)}
              </option>
            ))}
          </select>
          <label htmlFor="credit-invoice">Invoice</label>
          <select
            id="credit-invoice"
            value={invoiceId}
            onChange={(event) => {
              setInvoiceId(event.target.value);
            }}
          >
            <option value="">Choose an invoice</option>
            {invoices.map((item) => (
              <option key={item.id} value={item.id}>
                Invoice #{item.number} · {money(item.balanceCents ?? 0)} due
              </option>
            ))}
          </select>
          {amountCents > 0 ? (
            <p>{money(amountCents)} will be applied.</p>
          ) : null}
          <button
            className="button"
            type="button"
            disabled={busy || amountCents < 1}
            onClick={() => void apply()}
          >
            {busy ? 'Applying…' : 'Apply credit'}
          </button>
        </>
      ) : null}
      {!loading && nextBeforeNumber !== null ? (
        <button
          className="button"
          type="button"
          onClick={() => void load(nextBeforeNumber)}
        >
          Load more invoices
        </button>
      ) : null}
      {!loading && error && invoices.length === 0 ? (
        <button
          className="button"
          type="button"
          onClick={() => void load(null)}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
