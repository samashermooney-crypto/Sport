import type { RouteObject } from 'react-router';

import { PortalPersonSafety, PublicCardVerification } from './PortalSafety';

export const portalSafetyRoutes: readonly RouteObject[] = [
  {
    path: '/me/safety/:orgId/people/:personId',
    element: <PortalPersonSafety />,
  },
  { path: '/cards/verify/:token', element: <PublicCardVerification /> },
];
