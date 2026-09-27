import type { RouteObject } from 'react-router';

import { Credentials } from './Credentials';
import { Start } from './Start';

export const orgsRoutes: readonly RouteObject[] = [
  { path: '/start', element: <Start /> },
  { path: '/orgs/:orgId/credentials', element: <Credentials /> },
];
