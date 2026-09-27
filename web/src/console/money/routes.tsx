import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { useParams } from 'react-router';
import type { RouteObject } from 'react-router';

import { apiGet } from '../../api/client';
import { PageHeader } from '../../ui/primitives';
import { AppShell } from '../../ui/shell';

const Installments = lazy(() =>
  import('./InstallmentStaffScreen').then(
    ({ InstallmentStaffScreen: component }) => ({ default: component }),
  ),
);

function StaffInstallmentsRoute(): React.JSX.Element {
  const { orgId, invoiceId } = useParams<{
    orgId: string;
    invoiceId: string;
  }>();
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () =>
      apiGet(`/orgs/${String(orgId)}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  if (!orgId || !invoiceId) return <main>Invoice unavailable.</main>;
  return (
    <AppShell
      orgName={workspace.data?.name ?? 'Athlentry'}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Account', to: '/me' },
      ]}
    >
      <main className="console-home">
        <PageHeader
          kicker="FINANCE"
          title="Invoice installments"
          description="Review the schedule and record authorized staff changes."
        />
        <Suspense fallback={<p role="status">Loading installments…</p>}>
          <Installments orgId={orgId} invoiceId={invoiceId} />
        </Suspense>
      </main>
    </AppShell>
  );
}

export const moneyConsoleRoutes: readonly RouteObject[] = [
  {
    path: '/console/orgs/:orgId/finance/invoices/:invoiceId/installments',
    element: <StaffInstallmentsRoute />,
  },
];
