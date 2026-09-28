import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { apiGet } from '../../api/client';
import { AppShell } from '../../ui/shell';

import { ActionCenter } from './ActionCenter';
import { OrganizationData } from './OrganizationData';

function ActionCenterRoute(): React.JSX.Element {
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
    return <main role="alert">Organization home is unavailable.</main>;

  return (
    <AppShell
      orgName={workspace.data.name}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            {
              label: 'Action Center',
              to: `/console/orgs/${orgId}/action-center`,
              current: true,
            },
            { label: 'Data exports', to: `/console/orgs/${orgId}/data` },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        {
          label: 'Actions',
          to: `/console/orgs/${orgId}/action-center`,
          current: true,
        },
        { label: 'Account', to: '/me' },
      ]}
    >
      <ActionCenter orgId={orgId} />
    </AppShell>
  );
}

function OrganizationDataRoute(): React.JSX.Element {
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
    return <main role="alert">Organization data is unavailable.</main>;

  return (
    <AppShell
      orgName={workspace.data.name}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            {
              label: 'Action Center',
              to: `/console/orgs/${orgId}/action-center`,
            },
            {
              label: 'Data exports',
              to: `/console/orgs/${orgId}/data`,
              current: true,
            },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Data', to: `/console/orgs/${orgId}/data`, current: true },
        { label: 'Account', to: '/me' },
      ]}
    >
      <OrganizationData orgId={orgId} />
    </AppShell>
  );
}

export const consoleHomeRoutes: readonly RouteObject[] = [
  {
    path: '/console/orgs/:orgId/action-center',
    element: <ActionCenterRoute />,
  },
  {
    path: '/console/orgs/:orgId/data',
    element: <OrganizationDataRoute />,
  },
];
