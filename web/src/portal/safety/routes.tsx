import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { PortalShell } from '../PortalShell';

const PortalPersonSafety = lazy(() =>
  import('./PortalSafety').then(({ PortalPersonSafety: Component }) => ({
    default: Component,
  })),
);
const PublicCardVerification = lazy(() =>
  import('./PortalSafety').then(({ PublicCardVerification: Component }) => ({
    default: Component,
  })),
);

function PortalSafetyRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <PortalShell orgId={orgId}>
      <Suspense fallback={<main role="status">Loading safety records…</main>}>
        <PortalPersonSafety />
      </Suspense>
    </PortalShell>
  ) : (
    <main role="status">Safety record not found.</main>
  );
}

export const portalSafetyRoutes: readonly RouteObject[] = [
  {
    path: '/me/safety/:orgId/people/:personId',
    element: <PortalSafetyRoute />,
  },
  {
    path: '/cards/verify/:token',
    element: (
      <Suspense fallback={<main role="status">Loading card…</main>}>
        <PublicCardVerification />
      </Suspense>
    ),
  },
];
