import { formatMoney } from '@shared/money';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';

import './money.css';

const overviewSchema = z.strictObject({
  plans: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      monthlyPriceCents: z.number().int().nonnegative(),
    }),
  ),
  subscription: z
    .strictObject({
      planId: z.uuid().nullable(),
      status: z.string(),
      currentPeriodEnd: z.iso.datetime().nullable(),
    })
    .nullable(),
  checkout: z
    .strictObject({
      planId: z.uuid(),
      status: z.enum(['reserved', 'external_started', 'created']),
      url: z.url().nullable(),
    })
    .nullable(),
});
const checkoutSchema = z.strictObject({
  sessionId: z.string().startsWith('cs_'),
  url: z.url(),
});
const portalSchema = z.strictObject({ url: z.url() });

function stripeDestination(url: string, host: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== host)
    throw new Error('Stripe returned an unexpected destination');
  return parsed.toString();
}

export function BillingScreen({
  orgId,
  navigate = (url: string) => {
    window.location.assign(url);
  },
}: {
  orgId: string;
  navigate?: (url: string) => void;
}): React.JSX.Element {
  const [overview, setOverview] = useState<z.output<
    typeof overviewSchema
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const checkoutKeys = useRef(new Map<string, string>());
  const path = `/finance/orgs/${encodeURIComponent(orgId)}/billing`;
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setOverview(await apiGet(path, overviewSchema));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Billing is unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);

  const checkout = async (planId: string): Promise<void> => {
    setBusy(true);
    setError('');
    const key = checkoutKeys.current.get(planId) ?? crypto.randomUUID();
    checkoutKeys.current.set(planId, key);
    try {
      const result = await apiPost(
        `${path}/checkout`,
        { planId },
        checkoutSchema,
        key,
      );
      navigate(stripeDestination(result.url, 'checkout.stripe.com'));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Checkout is unavailable.',
      );
    } finally {
      setBusy(false);
    }
  };

  const portal = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const result = await apiPost(`${path}/portal`, {}, portalSchema);
      navigate(stripeDestination(result.url, 'billing.stripe.com'));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Billing portal is unavailable.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p role="status">Loading organization billing…</p>;
  return (
    <section className="money-panel">
      <h2>Platform billing</h2>
      {error && (
        <p role="alert" className="money-error">
          {error}
        </p>
      )}
      {!overview ? (
        <button className="button" type="button" onClick={() => void load()}>
          Retry
        </button>
      ) : (
        <>
          <p>
            Subscription:{' '}
            {overview.subscription?.status ?? 'No subscription yet'}
            {overview.subscription?.currentPeriodEnd
              ? ` · Current period ends ${overview.subscription.currentPeriodEnd.slice(0, 10)}`
              : ''}
          </p>
          {overview.subscription &&
          !['pending', 'canceled', 'incomplete_expired'].includes(
            overview.subscription.status,
          ) ? (
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void portal()}
            >
              Manage billing in Stripe
            </button>
          ) : overview.checkout?.status === 'created' &&
            overview.checkout.url ? (
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => {
                try {
                  navigate(
                    stripeDestination(
                      overview.checkout?.url ?? '',
                      'checkout.stripe.com',
                    ),
                  );
                } catch (caught) {
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : 'Checkout is unavailable.',
                  );
                }
              }}
            >
              Continue Stripe Checkout
            </button>
          ) : overview.checkout ? (
            <p role="status">
              Billing Checkout needs reconciliation before it can continue.
            </p>
          ) : (
            <ul className="money-installments">
              {overview.plans.map((plan) => (
                <li key={plan.id}>
                  <strong>{plan.name}</strong> ·{' '}
                  {formatMoney(plan.monthlyPriceCents, 'en-US')} per month{' '}
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => void checkout(plan.id)}
                  >
                    Choose {plan.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
