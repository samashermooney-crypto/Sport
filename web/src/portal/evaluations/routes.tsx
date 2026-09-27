import type { RouteObject } from 'react-router';

import {
  EvaluationScoringSheet,
  FamilyOffers,
  FamilyPlacementPreferences,
  FamilyResults,
} from './EvaluationPortal';

export const portalEvaluationsRoutes: readonly RouteObject[] = [
  {
    path: '/portal/orgs/:orgId/evaluations/:eventId/score',
    element: <EvaluationScoringSheet />,
  },
  { path: '/portal/orgs/:orgId/offers', element: <FamilyOffers /> },
  { path: '/portal/orgs/:orgId/results', element: <FamilyResults /> },
  {
    path: '/portal/orgs/:orgId/placement-preferences',
    element: <FamilyPlacementPreferences />,
  },
];
