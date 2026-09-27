import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { PortalShell } from '../PortalShell';

import { NotificationCenter } from './NotificationCenter';

function NotificationRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <PortalShell orgId={orgId}>
      <NotificationCenter orgId={orgId} />
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
