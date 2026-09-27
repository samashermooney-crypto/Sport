import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { PortalShell } from '../PortalShell';

const StorePortalPage = lazy(() =>
  import('./StorePortal').then(({ StorePortal: Component }) => ({
    default: Component,
  })),
);

function StorePortalRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <PortalShell orgId={orgId}>
      <Suspense fallback={<main role="status">Loading store…</main>}>
        <StorePortalPage orgId={orgId} />
      </Suspense>
    </PortalShell>
  ) : (
    <main>Organization not found.</main>
  );
}

export const portalStoreRoutes: readonly RouteObject[] = [
  { path: '/me/orgs/:orgId/store', element: <StorePortalRoute /> },
];
