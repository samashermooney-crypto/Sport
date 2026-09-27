import type { RouteObject } from 'react-router';

import { EvaluationScoringSheet, FamilyOffers, FamilyResults } from './EvaluationPortal';

export const portalEvaluationRoutes: readonly RouteObject[] = [
  { path: '/portal/orgs/:orgId/evaluations/:eventId/score', element: <EvaluationScoringSheet /> },
  { path: '/portal/orgs/:orgId/offers', element: <FamilyOffers /> },
  { path: '/portal/orgs/:orgId/results', element: <FamilyResults /> },
];
