import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const StoreConsole = lazy(() =>
  import('./StoreConsole').then(({ StoreConsole: Component }) => ({
    default: Component,
  })),
);

function StoreRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  if (!orgId) return <main>Organization not found.</main>;
  return (
    <Suspense fallback={<main role="status">Loading store…</main>}>
      <StoreConsole orgId={orgId} />
    </Suspense>
  );
}

export const consoleStoreRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/store', element: <StoreRoute /> },
];
