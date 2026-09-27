import type { RouteObject } from 'react-router';

import {
  SafetyBackgroundChecks,
  SafetyCards,
  SafetyCredentialReviews,
  SafetyDashboard,
  SafetyIncidents,
  SafetyInjuries,
  SafetyRequirements,
  SafetySettings,
} from './ConsoleSafety';

export const consoleSafetyRoutes: readonly RouteObject[] = [
  { path: '/console/safety/:orgId', element: <SafetyDashboard /> },
  {
    path: '/console/safety/:orgId/review',
    element: <SafetyCredentialReviews />,
  },
  {
    path: '/console/safety/:orgId/requirements',
    element: <SafetyRequirements />,
  },
  { path: '/console/safety/:orgId/injuries', element: <SafetyInjuries /> },
  { path: '/console/safety/:orgId/incidents', element: <SafetyIncidents /> },
  {
    path: '/console/safety/:orgId/background-checks',
    element: <SafetyBackgroundChecks />,
  },
  {
    path: '/console/safety/:orgId/background-check-settings',
    element: <SafetySettings />,
  },
  { path: '/console/safety/:orgId/cards', element: <SafetyCards /> },
];
