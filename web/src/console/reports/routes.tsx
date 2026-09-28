import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { apiGet } from '../../api/client';
import { AppShell } from '../../ui/shell';

import { ReportBuilder } from './ReportBuilder';
import { ReportsDashboard } from './ReportsDashboard';

function ReportsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () =>
      apiGet(`/orgs/${String(orgId)}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  if (!orgId) return <main>Organization not found.</main>;
  if (workspace.isPending) return <p role="status">Loading organization…</p>;
  if (workspace.isError)
    return <main role="alert">Organization reports are unavailable.</main>;
  return (
    <AppShell
      orgName={workspace.data.name}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            {
              label: 'Reports',
              to: `/console/orgs/${orgId}/reports`,
              current: true,
            },
            { label: 'Staff', to: `/orgs/${orgId}/staff` },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        {
          label: 'Reports',
          to: `/console/orgs/${orgId}/reports`,
          current: true,
        },
        { label: 'Account', to: '/me' },
      ]}
    >
      <ReportsDashboard orgId={orgId} />
      <ReportBuilder orgId={orgId} />
    </AppShell>
  );
}

export const consoleReportsRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/reports', element: <ReportsRoute /> },
];
