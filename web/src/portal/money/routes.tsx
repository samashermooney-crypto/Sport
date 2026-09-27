import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';
import { z } from 'zod';

import { apiGet } from '../../api/client';
import { Link, PageHeader } from '../../ui/primitives';
import { PortalShell } from '../PortalShell';

const Invoices = lazy(() =>
  import('./InvoiceBalanceScreen').then(
    ({ InvoiceBalanceScreen: component }) => ({ default: component }),
  ),
);
const Credits = lazy(() =>
  import('./CreditBalanceScreen').then(
    ({ CreditBalanceScreen: component }) => ({ default: component }),
  ),
);
const Receipts = lazy(() =>
  import('./ReceiptsScreen').then(({ ReceiptsScreen: component }) => ({
    default: component,
  })),
);
const Statements = lazy(() =>
  import('./YearEndStatementScreen').then(
    ({ YearEndStatementScreen: component }) => ({ default: component }),
  ),
);
const Autopay = lazy(() =>
  import('./AutopayScreen').then(({ AutopayScreen: component }) => ({
    default: component,
  })),
);
const Installments = lazy(() =>
  import('./ManualInstallmentPayScreen').then(
    ({ ManualInstallmentPayScreen: component }) => ({ default: component }),
  ),
);
const SavedMethods = lazy(() =>
  import('./SavedPaymentMethodsScreen').then(
    ({ SavedPaymentMethodsScreen: component }) => ({ default: component }),
  ),
);

const stripeClientConfigSchema = z.strictObject({
  publishableKey: z.string().startsWith('pk_test_'),
});

type Area =
  | 'home'
  | 'invoices'
  | 'installments'
  | 'credits'
  | 'receipts'
  | 'statements'
  | 'autopay'
  | 'payment-methods';

function MoneyRoute({ area }: { area: Area }): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () =>
      apiGet(`/orgs/${String(orgId)}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  const stripeClient = useQuery({
    queryKey: ['finance', 'stripe-client-config'],
    queryFn: () =>
      apiGet('/finance/stripe-client-config', stripeClientConfigSchema),
    enabled: area === 'payment-methods',
  });
  if (!orgId) return <main>Organization not found.</main>;
  const base = `/portal/orgs/${orgId}/money`;
  const name = workspace.data?.name ?? 'Your organization';
  const links = [
    { label: 'Invoices', path: 'invoices' },
    { label: 'Pay installments', path: 'installments' },
    { label: 'Credits', path: 'credits' },
    { label: 'Receipts', path: 'receipts' },
    { label: 'Year-end statements', path: 'statements' },
    { label: 'Autopay', path: 'autopay' },
    { label: 'Payment methods', path: 'payment-methods' },
  ];
  return (
    <PortalShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="FAMILY FINANCES"
          title="Payments"
          description="Review your invoices, receipts and payment settings."
        />
        <nav aria-label="Payment pages">
          <ul>
            {links.map(({ label, path }) => (
              <li key={path}>
                <Link to={`${base}/${path}`}>{label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <Suspense fallback={<p role="status">Loading payment details…</p>}>
          {area === 'invoices' && <Invoices orgId={orgId} orgName={name} />}
          {area === 'installments' && <Installments orgId={orgId} />}
          {area === 'credits' && <Credits orgId={orgId} orgName={name} />}
          {area === 'receipts' && <Receipts orgId={orgId} orgName={name} />}
          {area === 'statements' && <Statements orgId={orgId} orgName={name} />}
          {area === 'autopay' && <Autopay orgId={orgId} orgName={name} />}
          {area === 'payment-methods' &&
            (stripeClient.isPending ? (
              <p role="status">Loading payment method settings…</p>
            ) : stripeClient.isError ? (
              <p role="alert">Payment method settings are unavailable.</p>
            ) : (
              <SavedMethods
                publishableKey={stripeClient.data.publishableKey}
                returnUrl={`${window.location.origin}${base}/payment-methods`}
              />
            ))}
        </Suspense>
      </main>
    </PortalShell>
  );
}

export const portalMoneyRoutes: readonly RouteObject[] = [
  { path: '/portal/orgs/:orgId/money', element: <MoneyRoute area="home" /> },
  ...(
    [
      'invoices',
      'installments',
      'credits',
      'receipts',
      'statements',
      'autopay',
      'payment-methods',
    ] as const
  ).map((area) => ({
    path: `/portal/orgs/:orgId/money/${area}`,
    element: <MoneyRoute area={area} />,
  })),
];
