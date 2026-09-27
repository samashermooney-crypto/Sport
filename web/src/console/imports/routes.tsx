import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const ImportsScreen = lazy(() =>
  import('./ImportsScreen').then(({ ImportsScreen: Component }) => ({
    default: Component,
  })),
);

function ImportsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading imports…</main>}>
      <ImportsScreen orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

export const importsConsoleRoutes: RouteObject[] = [
  { path: '/console/orgs/:orgId/imports', element: <ImportsRoute /> },
];
