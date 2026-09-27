import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const SponsorsConsolePage = lazy(() =>
  import('./SponsorsConsole').then(({ SponsorsConsole: Component }) => ({
    default: Component,
  })),
);

function SponsorsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading sponsors…</main>}>
      <SponsorsConsolePage orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

export const consoleSponsorsRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/sponsors', element: <SponsorsRoute /> },
];
