import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';

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

export const portalSafetyRoutes: readonly RouteObject[] = [
  {
    path: '/me/safety/:orgId/people/:personId',
    element: (
      <Suspense fallback={<main role="status">Loading safety records…</main>}>
        <PortalPersonSafety />
      </Suspense>
    ),
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
