import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { MessagesPortal } from './MessagesPortal';

function PortalMessagesRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <MessagesPortal orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

export const messagesPortalRoutes: readonly RouteObject[] = [
  { path: '/me/orgs/:orgId/messages', element: <PortalMessagesRoute /> },
];
