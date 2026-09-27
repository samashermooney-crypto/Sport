import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { NotificationCenter } from './NotificationCenter';

function NotificationRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <NotificationCenter orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

export const notificationPortalRoutes: readonly RouteObject[] = [
  {
    path: '/portal/orgs/:orgId/notifications',
    element: <NotificationRoute />,
  },
];
