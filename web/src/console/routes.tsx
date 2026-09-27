import { lazy, Suspense } from 'react';

import { RouteLoading } from '../ui/RouteLoading';

const ConsoleHome = lazy(() =>
  import('./Home').then(({ ConsoleHome: Component }) => ({
    default: Component,
  })),
);

export const consoleRoutes = [
  {
    path: '/console/orgs/:orgId',
    element: (
      <Suspense fallback={<RouteLoading label="Loading organization…" />}>
        <ConsoleHome />
      </Suspense>
    ),
  },
];
