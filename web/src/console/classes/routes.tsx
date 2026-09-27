import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { apiGet } from '../../api/client';
import { AppShell } from '../../ui/shell';

const AcademyConsoleScreen = lazy(() =>
  import('./AcademyConsoleScreen').then(({ AcademyConsoleScreen: screen }) => ({
    default: screen,
  })),
);

function AcademyRoute(): React.JSX.Element {
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
          label: 'Programs',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            { label: 'Classes', to: `/console/orgs/${orgId}/classes` },
            { label: 'Account', to: '/me' },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Classes', to: `/console/orgs/${orgId}/classes` },
        { label: 'Account', to: '/me' },
      ]}
    >
      <Suspense fallback={<main role="status">Loading academy…</main>}>
        <AcademyConsoleScreen orgId={orgId} />
      </Suspense>
    </AppShell>
  );
}

export const consoleClassesRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/classes', element: <AcademyRoute /> },
];
