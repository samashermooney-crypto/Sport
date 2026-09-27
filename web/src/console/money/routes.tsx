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
const Billing = lazy(() =>
  import('./BillingScreen').then(({ BillingScreen: component }) => ({
    default: component,
  })),
);
const Connect = lazy(() =>
  import('./ConnectScreen').then(({ ConnectScreen: component }) => ({
    default: component,
  })),
);
const ConnectReturnScreen = lazy(() =>
  import('./ConnectScreen').then(({ ConnectReturn }) => ({
    default: ConnectReturn,
  })),
);
const ConnectRefreshScreen = lazy(() =>
  import('./ConnectScreen').then(({ ConnectRefresh }) => ({
    default: ConnectRefresh,
  })),
);

function ConnectReturnRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () =>
      apiGet(`/orgs/${String(orgId)}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  if (!orgId) return <main>Organization not found.</main>;
  return (
    <AppShell
      orgName={workspace.data?.name ?? 'Athlentry'}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            {
              label: 'Payment processing',
              to: `/console/orgs/${orgId}/money/connect`,
            },
            {
              label: 'Platform billing',
              to: `/console/orgs/${orgId}/money/billing`,
            },
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
          title="Payment processing"
          description="Connect and manage your organization’s Stripe Express account."
        />
        <Suspense fallback={<p role="status">Loading Stripe connection…</p>}>
          <ConnectReturnScreen orgId={orgId} />
        </Suspense>
      </main>
    </AppShell>
  );
}

function ConnectRefreshRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  if (!orgId) return <main>Organization not found.</main>;
  return (
    <Suspense fallback={<p role="status">Resuming Stripe setup…</p>}>
      <ConnectRefreshScreen orgId={orgId} />
    </Suspense>
  );
}

function ConnectSetupRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () =>
      apiGet(`/orgs/${String(orgId)}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  if (!orgId) return <main>Organization not found.</main>;
  return (
    <AppShell
      orgName={workspace.data?.name ?? 'Athlentry'}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            {
              label: 'Payment processing',
              to: `/console/orgs/${orgId}/money/connect`,
            },
            {
              label: 'Platform billing',
              to: `/console/orgs/${orgId}/money/billing`,
            },
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
          title="Payment processing"
          description="Connect and manage your organization’s Stripe Express account."
        />
        <Suspense fallback={<p role="status">Loading Stripe connection…</p>}>
          <Connect orgId={orgId} />
        </Suspense>
      </main>
    </AppShell>
  );
}

function BillingRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () =>
      apiGet(`/orgs/${String(orgId)}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  if (!orgId) return <main>Organization not found.</main>;
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
          title="Platform billing"
          description="Choose or manage your organization subscription."
        />
        <Suspense fallback={<p role="status">Loading billing…</p>}>
          <Billing orgId={orgId} />
        </Suspense>
      </main>
    </AppShell>
  );
}

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

export const consoleMoneyRoutes: readonly RouteObject[] = [
  {
    path: '/console/orgs/:orgId/money/connect',
    element: <ConnectSetupRoute />,
  },
  {
    path: '/console/orgs/:orgId/money/connect/return',
    element: <ConnectReturnRoute />,
  },
  {
    path: '/console/orgs/:orgId/money/connect/refresh',
    element: <ConnectRefreshRoute />,
  },
  {
    path: '/console/orgs/:orgId/money/billing',
    element: <BillingRoute />,
  },
  {
    path: '/console/orgs/:orgId/finance/invoices/:invoiceId/installments',
    element: <StaffInstallmentsRoute />,
  },
];
