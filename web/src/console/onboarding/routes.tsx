import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { ConsoleShell } from '../../ui/ConsoleShell';

const OnboardingScreen = lazy(() =>
  import('./OnboardingScreen').then(({ OnboardingScreen: Component }) => ({
    default: Component,
  })),
);
const ImportsScreen = lazy(() =>
  import('./ImportsScreen').then(({ ImportsScreen: Component }) => ({
    default: Component,
  })),
);

function OnboardingRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <ConsoleShell orgId={orgId}>
      <Suspense fallback={<main role="status">Loading setup…</main>}>
        <OnboardingScreen orgId={orgId} />
      </Suspense>
    </ConsoleShell>
  ) : (
    <main>Organization not found.</main>
  );
}

function ImportsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <ConsoleShell orgId={orgId}>
      <Suspense fallback={<main role="status">Loading imports…</main>}>
        <ImportsScreen orgId={orgId} />
      </Suspense>
    </ConsoleShell>
  ) : (
    <main>Organization not found.</main>
  );
}

export const consoleOnboardingRoutes: RouteObject[] = [
  { path: '/console/orgs/:orgId/onboarding', element: <OnboardingRoute /> },
  {
    path: '/console/orgs/:orgId/onboarding/imports',
    element: <ImportsRoute />,
  },
];
