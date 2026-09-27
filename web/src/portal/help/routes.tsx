import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const HelpCenter = lazy(() =>
  import('../../console/help/HelpCenter').then(({ HelpCenter: Component }) => ({
    default: Component,
  })),
);

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

export const portalHelpRoutes: RouteObject[] = [
  { path: '/portal/orgs/:orgId/help', element: <PortalHelpRoute /> },
];
