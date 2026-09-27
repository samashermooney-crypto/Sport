import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';

import {
  assertStripeDestination,
  ConnectOnboarding,
  type ConnectAccountView,
} from './ConnectOnboarding';

const statusSchema = z.object({
  stripeAccountId: z.string().startsWith('acct_').nullable(),
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  detailsSubmitted: z.boolean(),
  requirementsDue: z.array(z.string()),
  disabledReason: z.string().nullable(),
});
const linkSchema = z.object({ url: z.url().startsWith('https://') });
const browserNavigate = (url: string): void => {
  window.location.assign(url);
};

export function ConnectScreen({
  orgId,
  navigate,
}: {
  orgId: string;
  navigate?: (url: string) => void;
}): React.JSX.Element {
  const [account, setAccount] = useState<ConnectAccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const path = `/finance/orgs/${encodeURIComponent(orgId)}/connect`;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const status = await apiGet(`${path}/status`, statusSchema);
      setAccount(status);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Connection status is unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p role="status">Checking Stripe connection…</p>;
  if (error)
    return (
      <section className="money-panel">
        <p role="alert" className="money-error">
          {error}
        </p>
        <button className="button" type="button" onClick={() => void load()}>
          Retry
        </button>
      </section>
    );
  if (!account) return <p role="alert">Connection status is unavailable.</p>;
  return (
    <ConnectOnboarding
      account={account}
      {...(navigate ? { navigate } : {})}
      actions={{
        createAccount: () => apiPost(`${path}/onboarding`, {}, linkSchema),
        continueOnboarding: () => apiPost(`${path}/continue`, {}, linkSchema),
        openDashboard: () => apiPost(`${path}/dashboard`, {}, linkSchema),
      }}
    />
  );
}

export function ConnectReturn({
  orgId,
  navigate,
}: {
  orgId: string;
  navigate?: (url: string) => void;
}): React.JSX.Element {
  return <ConnectScreen orgId={orgId} {...(navigate ? { navigate } : {})} />;
}

export function ConnectRefresh({
  orgId,
  navigate = browserNavigate,
}: {
  orgId: string;
  navigate?: (url: string) => void;
}): React.JSX.Element {
  const [error, setError] = useState('');
  const path = `/finance/orgs/${encodeURIComponent(orgId)}/connect/continue`;
  const continueOnboarding = useCallback(async (): Promise<void> => {
    setError('');
    try {
      const { url } = await apiPost(path, {}, linkSchema);
      assertStripeDestination(url);
      navigate(url);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Stripe setup could not continue.',
      );
    }
  }, [path, navigate]);
  useEffect(() => {
    void continueOnboarding();
  }, [continueOnboarding]);
  return (
    <section className="money-panel">
      <h2>Continuing Stripe setup</h2>
      {error ? (
        <>
          <p role="alert" className="money-error">
            {error}
          </p>
          <button
            className="button"
            type="button"
            onClick={() => void continueOnboarding()}
          >
            Retry Stripe setup
          </button>
        </>
      ) : (
        <p role="status">Opening secure Stripe setup…</p>
      )}
    </section>
  );
}
