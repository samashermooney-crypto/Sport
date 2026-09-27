import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { apiGet } from '../../api/client';
import { PageHeader } from '../../ui/primitives';
import { AppShell } from '../../ui/shell';

import { TeamConsole } from './TeamConsole';

function TeamsRoute(): React.JSX.Element {
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
        { label: 'Teams', to: `/console/orgs/${orgId}/teams` },
      ]}
    >
      <main className="console-home">
        <PageHeader
          kicker="TEAMS"
          title="Team seasons and rosters"
          description="Build teams, manage rosters and assign eligible staff."
        />
        <TeamConsole orgId={orgId} />
      </main>
    </AppShell>
  );
}
export const teamConsoleRoutes = [
  { path: '/console/orgs/:orgId/teams', element: <TeamsRoute /> },
];
