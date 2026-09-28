import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { apiGet } from '../../api/client';
import { PageHeader } from '../../ui/primitives';
import { AppShell } from '../../ui/shell';

import { FacilitiesConsole } from './FacilitiesConsole';

function FacilitiesRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () =>
      apiGet(`/orgs/${String(orgId)}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  if (!orgId) return <main>Organization unavailable.</main>;
  return (
    <AppShell
      orgName={workspace.data?.name ?? 'Athlentry'}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            { label: 'Programs', to: `/console/orgs/${orgId}/programs` },
            { label: 'Teams', to: `/console/orgs/${orgId}/teams` },
            { label: 'Facilities', to: `/console/orgs/${orgId}/facilities` },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Programs', to: `/console/orgs/${orgId}/programs` },
        { label: 'Facilities', to: `/console/orgs/${orgId}/facilities` },
      ]}
    >
      <main className="console-home">
        <PageHeader
          kicker="FACILITIES"
          title="Facilities and spaces"
          description="Manage fields, split spaces, availability and blackout dates."
        />
        <FacilitiesConsole orgId={orgId} />
      </main>
    </AppShell>
  );
}
export const consoleFacilitiesRoutes = [
  { path: '/console/orgs/:orgId/facilities', element: <FacilitiesRoute /> },
];
