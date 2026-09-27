import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';

const PlatformConsole = lazy(() =>
  import('./PlatformConsole').then(({ PlatformConsole: Component }) => ({
    default: Component,
  })),
);

export const platformRoutes: readonly RouteObject[] = [
  {
    path: '/platform',
    element: (
      <Suspense fallback={<main role="status">Loading platform console…</main>}>
        <PlatformConsole />
      </Suspense>
    ),
  },
];
