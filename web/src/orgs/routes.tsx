import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';

import { ConsoleRouteShell } from '../ui/ConsoleShell';
import { RouteLoading } from '../ui/RouteLoading';

const AcceptInvitation = lazy(() =>
  import('./AcceptInvitation').then(({ AcceptInvitation: Component }) => ({
    default: Component,
  })),
);
const AcceptOwnershipTransfer = lazy(() =>
  import('./AcceptOwnershipTransfer').then(
    ({ AcceptOwnershipTransfer: Component }) => ({ default: Component }),
  ),
);
const Credentials = lazy(() =>
  import('./Credentials').then(({ Credentials: Component }) => ({
    default: Component,
  })),
);
const Profile = lazy(() =>
  import('./Profile').then(({ Profile: Component }) => ({
    default: Component,
  })),
);
const Staff = lazy(() =>
  import('./Staff').then(({ Staff: Component }) => ({ default: Component })),
);
const Start = lazy(() =>
  import('./Start').then(({ Start: Component }) => ({ default: Component })),
);

function loading(element: React.ReactNode): React.JSX.Element {
  return (
    <Suspense fallback={<RouteLoading label="Loading organization…" />}>
      {element}
    </Suspense>
  );
}

export const orgsRoutes: readonly RouteObject[] = [
  { path: '/start', element: loading(<Start />) },
  {
    path: '/orgs/:orgId/credentials',
    element: loading(
      <ConsoleRouteShell>
        <Credentials />
      </ConsoleRouteShell>,
    ),
  },
  {
    path: '/orgs/:orgId/profile',
    element: loading(
      <ConsoleRouteShell>
        <Profile />
      </ConsoleRouteShell>,
    ),
  },
  {
    path: '/orgs/:orgId/staff',
    element: loading(
      <ConsoleRouteShell>
        <Staff />
      </ConsoleRouteShell>,
    ),
  },
  {
    path: '/invitations/:orgId/:token',
    element: loading(<AcceptInvitation />),
  },
  {
    path: '/ownership-transfer/:orgId/:token',
    element: loading(<AcceptOwnershipTransfer />),
  },
];
