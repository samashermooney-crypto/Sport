import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { PortalShell } from '../PortalShell';

const VolunteerPortalPage = lazy(() =>
  import('./VolunteerPortal').then(({ VolunteerPortal: Component }) => ({
    default: Component,
  })),
);

function VolunteerPortalRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <PortalShell orgId={orgId}>
      <Suspense fallback={<main role="status">Loading volunteer shifts…</main>}>
        <VolunteerPortalPage orgId={orgId} />
      </Suspense>
    </PortalShell>
  ) : (
    <main>Organization not found.</main>
  );
}

export const volunteersPortalRoutes: readonly RouteObject[] = [
  { path: '/me/orgs/:orgId/volunteers', element: <VolunteerPortalRoute /> },
];
