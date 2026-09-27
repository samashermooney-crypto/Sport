import type { RouteObject } from 'react-router';

import { SitePage } from './SitePage';

export const siteRoutes: readonly RouteObject[] = [
  { path: '/site/:orgSlug', element: <SitePage /> },
  { path: '/site/:orgSlug/*', element: <SitePage /> },
];
