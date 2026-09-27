import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

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
    <Suspense fallback={<main role="status">Loading setup…</main>}>
      <OnboardingScreen orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

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

export const consoleOnboardingRoutes: RouteObject[] = [
  { path: '/console/orgs/:orgId/onboarding', element: <OnboardingRoute /> },
  {
    path: '/console/orgs/:orgId/onboarding/imports',
    element: <ImportsRoute />,
  },
];

export const onboardingRoutes = consoleOnboardingRoutes;
