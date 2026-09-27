import { lazy, Suspense } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import type { RouteObject } from 'react-router';

type SafetyScreen =
  | 'SafetyBackgroundChecks'
  | 'SafetyCards'
  | 'SafetyCredentialReviews'
  | 'SafetyDashboard'
  | 'SafetyIncidents'
  | 'SafetyInjuries'
  | 'SafetyRequirements'
  | 'SafetySettings';

const safetyScreens: Record<
  SafetyScreen,
  () => Promise<{ default: ComponentType }>
> = {
  SafetyBackgroundChecks: () =>
    import('./ConsoleSafety').then(({ SafetyBackgroundChecks }) => ({
      default: SafetyBackgroundChecks,
    })),
  SafetyCards: () =>
    import('./ConsoleSafety').then(({ SafetyCards }) => ({
      default: SafetyCards,
    })),
  SafetyCredentialReviews: () =>
    import('./ConsoleSafety').then(({ SafetyCredentialReviews }) => ({
      default: SafetyCredentialReviews,
    })),
  SafetyDashboard: () =>
    import('./ConsoleSafety').then(({ SafetyDashboard }) => ({
      default: SafetyDashboard,
    })),
  SafetyIncidents: () =>
    import('./ConsoleSafety').then(({ SafetyIncidents }) => ({
      default: SafetyIncidents,
    })),
  SafetyInjuries: () =>
    import('./ConsoleSafety').then(({ SafetyInjuries }) => ({
      default: SafetyInjuries,
    })),
  SafetyRequirements: () =>
    import('./ConsoleSafety').then(({ SafetyRequirements }) => ({
      default: SafetyRequirements,
    })),
  SafetySettings: () =>
    import('./ConsoleSafety').then(({ SafetySettings }) => ({
      default: SafetySettings,
    })),
};

function screen(name: SafetyScreen): LazyExoticComponent<ComponentType> {
  return lazy(safetyScreens[name]);
}

function route(path: string, name: SafetyScreen): RouteObject {
  const Screen = screen(name);
  return {
    path,
    element: (
      <Suspense fallback={<main role="status">Loading safety records…</main>}>
        <Screen />
      </Suspense>
    ),
  };
}

export const consoleSafetyRoutes: readonly RouteObject[] = [
  route('/console/safety/:orgId', 'SafetyDashboard'),
  route('/console/safety/:orgId/review', 'SafetyCredentialReviews'),
  route('/console/safety/:orgId/requirements', 'SafetyRequirements'),
  route('/console/safety/:orgId/injuries', 'SafetyInjuries'),
  route('/console/safety/:orgId/incidents', 'SafetyIncidents'),
  route('/console/safety/:orgId/background-checks', 'SafetyBackgroundChecks'),
  route('/console/safety/:orgId/background-check-settings', 'SafetySettings'),
  route('/console/safety/:orgId/cards', 'SafetyCards'),
];
