import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { RouteLoading } from '../../ui/RouteLoading';

const AuditViewer = lazy(() =>
  import('./AuditViewer').then(({ AuditViewer: Component }) => ({
    default: Component,
  })),
);

function AuditRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<RouteLoading label="Loading audit records…" />}>
      <AuditViewer orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

export const consoleAuditRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/audit', element: <AuditRoute /> },
];
