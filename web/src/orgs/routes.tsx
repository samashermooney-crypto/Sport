import type { RouteObject } from 'react-router';

import { Start } from './Start';

export const orgsRoutes: readonly RouteObject[] = [
  { path: '/start', element: <Start /> },
];
