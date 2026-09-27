import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const VolunteersConsolePage = lazy(() =>
  import('./VolunteersConsole').then(({ VolunteersConsole: Component }) => ({
    default: Component,
  })),
);

function VolunteersRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading volunteers…</main>}>
      <VolunteersConsolePage orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

export const consoleVolunteersRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/volunteers', element: <VolunteersRoute /> },
];
