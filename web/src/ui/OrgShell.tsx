import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';

import { apiGet } from '../api/client';

import { AppShell } from './shell';

export function OrgShell({
  orgId,
  children,
}: PropsWithChildren<{ orgId: string }>): React.JSX.Element {
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () => apiGet(`/orgs/${orgId}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  return (
    <AppShell
      orgName={workspace.data?.name ?? 'Athlentry'}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            { label: 'Imports', to: `/console/orgs/${orgId}/imports` },
            { label: 'Help', to: `/console/orgs/${orgId}/help` },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Help', to: `/console/orgs/${orgId}/help` },
      ]}
    >
      {children}
    </AppShell>
  );
}
