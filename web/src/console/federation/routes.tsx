import type { RouteObject } from 'react-router';

import { FederationConsole } from './FederationConsole';

export const consoleFederationRoutes: readonly RouteObject[] = [
  {
    path: '/console/federation/:orgId',
    element: <FederationConsole />,
  },
];
