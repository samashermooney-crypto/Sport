import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const TeamFinanceConsolePage = lazy(() =>
  import('../team-finance/TeamFinanceConsole').then(
    ({ TeamFinanceConsole: Component }) => ({ default: Component }),
  ),
);

function TeamFinanceRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading team finance…</main>}>
      <TeamFinanceConsolePage orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

export const consoleTeamFinanceRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/team-finance', element: <TeamFinanceRoute /> },
];
