import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const AiToolsScreen = lazy(() =>
  import('./AiToolsScreen').then(({ AiToolsScreen: Component }) => ({
    default: Component,
  })),
);

function AiToolsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading…</main>}>
      <AiToolsScreen orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

export const aiConsoleRoutes: RouteObject[] = [
  { path: '/console/orgs/:orgId/ai', element: <AiToolsRoute /> },
];
