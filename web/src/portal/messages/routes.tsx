import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { PortalShell } from '../PortalShell';

const MessagesPortal = lazy(() =>
  import('./MessagesPortal').then(({ MessagesPortal: Component }) => ({
    default: Component,
  })),
);

function PortalMessagesRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <PortalShell orgId={orgId}>
      <Suspense fallback={<main role="status">Loading messages…</main>}>
        <MessagesPortal orgId={orgId} />
      </Suspense>
    </PortalShell>
  ) : (
    <main>Organization not found.</main>
  );
}

export const messagesPortalRoutes: readonly RouteObject[] = [
  { path: '/me/orgs/:orgId/messages', element: <PortalMessagesRoute /> },
];
