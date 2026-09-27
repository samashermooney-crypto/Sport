import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const FundraisingConsolePage = lazy(() =>
  import('./FundraisingConsole').then(({ FundraisingConsole: Component }) => ({
    default: Component,
  })),
);

function FundraisingRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading campaigns…</main>}>
      <FundraisingConsolePage orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

export const fundraisingConsoleRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/fundraising', element: <FundraisingRoute /> },
];
