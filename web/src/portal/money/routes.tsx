import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

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

type Area =
  'home' | 'invoices' | 'credits' | 'receipts' | 'statements' | 'autopay';

function MoneyRoute({ area }: { area: Area }): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  if (!orgId) return <main>Organization not found.</main>;
  const base = `/portal/orgs/${orgId}/money`;
  const name = 'Your organization';
  const links = [
    { label: 'Invoices', path: 'invoices' },
    { label: 'Credits', path: 'credits' },
    { label: 'Receipts', path: 'receipts' },
    { label: 'Year-end statements', path: 'statements' },
    { label: 'Autopay', path: 'autopay' },
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
          {area === 'credits' && <Credits orgId={orgId} orgName={name} />}
          {area === 'receipts' && <Receipts orgId={orgId} orgName={name} />}
          {area === 'statements' && <Statements orgId={orgId} orgName={name} />}
          {area === 'autopay' && <Autopay orgId={orgId} orgName={name} />}
        </Suspense>
      </main>
    </PortalShell>
  );
}

export const moneyPortalRoutes: readonly RouteObject[] = [
  { path: '/portal/orgs/:orgId/money', element: <MoneyRoute area="home" /> },
  ...(
    ['invoices', 'credits', 'receipts', 'statements', 'autopay'] as const
  ).map((area) => ({
    path: `/portal/orgs/:orgId/money/${area}`,
    element: <MoneyRoute area={area} />,
  })),
];
