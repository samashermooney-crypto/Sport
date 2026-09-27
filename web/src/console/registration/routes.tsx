import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { useParams } from 'react-router';
import type { RouteObject } from 'react-router';

import { apiGet } from '../../api/client';
import { PageHeader } from '../../ui/primitives';
import { AppShell } from '../../ui/shell';

const RegistrationStaff = lazy(() =>
  import('./RegistrationStaffScreen').then(
    ({ RegistrationStaffScreen: component }) => ({ default: component }),
  ),
);

function RegistrationStaffRoute(): React.JSX.Element {
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
              label: 'Registrations',
              to: `/console/orgs/${orgId}/registrations`,
            },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Registrations', to: `/console/orgs/${orgId}/registrations` },
        { label: 'Account', to: '/me' },
      ]}
    >
      <main className="console-home">
        <PageHeader
          kicker="PROGRAMS"
          title="Registrations"
          description="Review registrations, approvals, cancellations, transfers and waitlist offers."
        />
        <Suspense fallback={<p role="status">Loading registrations…</p>}>
          <RegistrationStaff orgId={orgId} />
        </Suspense>
      </main>
    </AppShell>
  );
}

export const consoleRegistrationRoutes: readonly RouteObject[] = [
  {
    path: '/console/orgs/:orgId/registrations',
    element: <RegistrationStaffRoute />,
  },
];
