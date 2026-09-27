import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const HelpCenter = lazy(() =>
  import('./HelpCenter').then(({ HelpCenter: Component }) => ({
    default: Component,
  })),
);

function ConsoleHelpRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading help…</main>}>
      <HelpCenter orgId={orgId} audience="admin" />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

function PortalHelpRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading help…</main>}>
      <HelpCenter orgId={orgId} audience="family" />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

export const helpRoutes: RouteObject[] = [
  { path: '/console/orgs/:orgId/help', element: <ConsoleHelpRoute /> },
  { path: '/portal/orgs/:orgId/help', element: <PortalHelpRoute /> },
];
