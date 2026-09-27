import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { PortalShell } from '../PortalShell';

const TeamFinancePortalPage = lazy(() =>
  import('./TeamFinancePortal').then(({ TeamFinancePortal: Component }) => ({
    default: Component,
  })),
);

function TeamFinancePortalRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <PortalShell orgId={orgId}>
      <Suspense fallback={<main role="status">Loading team finances…</main>}>
        <TeamFinancePortalPage orgId={orgId} />
      </Suspense>
    </PortalShell>
  ) : (
    <main>Organization not found.</main>
  );
}

export const teamFinancePortalRoutes: readonly RouteObject[] = [
  { path: '/me/orgs/:orgId/team-finance', element: <TeamFinancePortalRoute /> },
];
