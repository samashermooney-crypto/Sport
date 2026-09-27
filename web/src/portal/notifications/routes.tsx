import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { RouteLoading } from '../../ui/RouteLoading';
import { PortalShell } from '../PortalShell';

const NotificationCenter = lazy(() =>
  import('./NotificationCenter').then(({ NotificationCenter: Component }) => ({
    default: Component,
  })),
);

function NotificationRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <PortalShell orgId={orgId}>
      <Suspense fallback={<RouteLoading label="Loading notifications…" />}>
        <NotificationCenter orgId={orgId} />
      </Suspense>
    </PortalShell>
  ) : (
    <main>Organization not found.</main>
  );
}

export const portalNotificationsRoutes: readonly RouteObject[] = [
  {
    path: '/portal/orgs/:orgId/notifications',
    element: <NotificationRoute />,
  },
];
