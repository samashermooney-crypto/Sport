import type { RouteObject } from 'react-router';

import { EvaluationList, EvaluationOperations } from './EvaluationsConsole';

export const consoleEvaluationsRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/evaluations', element: <EvaluationList /> },
  {
    path: '/console/orgs/:orgId/evaluations/:eventId',
    element: <EvaluationOperations />,
  },
];
