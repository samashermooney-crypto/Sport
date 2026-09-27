import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { apiGet } from '../../api/client';
import { PageHeader } from '../../ui/primitives';
import { AppShell } from '../../ui/shell';

import { ProgramConsole } from './ProgramConsole';
import { ProgramDetail } from './ProgramDetail';

function ProgramRoute(): React.JSX.Element {
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
          kicker="PROGRAMS"
          title="Seasons and programs"
          description="Set up sports, divisions, registration offerings and published programs."
        />
        <ProgramConsole orgId={orgId} />
      </main>
    </AppShell>
  );
}
export const programConsoleRoutes = [
  { path: '/console/orgs/:orgId/programs', element: <ProgramRoute /> },
];

function ProgramDetailRoute(): React.JSX.Element {
  const { orgId, programId } = useParams<{
    orgId: string;
    programId: string;
  }>();
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () =>
      apiGet(`/orgs/${String(orgId)}/workspace`, orgWorkspaceSchema),
    enabled: Boolean(orgId),
  });
  if (!orgId || !programId) return <main>Program unavailable.</main>;
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
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Programs', to: `/console/orgs/${orgId}/programs` },
      ]}
    >
      <main className="console-home">
        <PageHeader
          kicker="PROGRAM"
          title="Program settings"
          description="Manage divisions, offerings and publishing."
        />
        <ProgramDetail orgId={orgId} programId={programId} />
      </main>
    </AppShell>
  );
}
programConsoleRoutes.push({
  path: '/console/orgs/:orgId/programs/:programId',
  element: <ProgramDetailRoute />,
});
