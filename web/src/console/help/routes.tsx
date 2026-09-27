import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { aiFeaturesEnabled } from './ai-enabled';

const HelpCenter = lazy(() =>
  import('./HelpCenter').then(({ HelpCenter: Component }) => ({
    default: Component,
  })),
);
const AiToolsScreen = lazy(() =>
  import('./AiToolsScreen').then(({ AiToolsScreen: Component }) => ({
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

function AiToolsRoute(): React.JSX.Element | null {
  const { orgId } = useParams<{ orgId: string }>();
  if (!aiFeaturesEnabled || !orgId) return null;
  return (
    <Suspense fallback={<main role="status">Loading AI tools…</main>}>
      <AiToolsScreen orgId={orgId} />
    </Suspense>
  );
}

export const consoleHelpRoutes: RouteObject[] = [
  { path: '/console/orgs/:orgId/help', element: <ConsoleHelpRoute /> },
  { path: '/console/orgs/:orgId/ai', element: <AiToolsRoute /> },
];
