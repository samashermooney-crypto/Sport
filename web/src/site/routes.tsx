import type { RouteObject } from 'react-router';

import { SiteNewsPage } from './SiteNewsPage';
import { SitePage } from './SitePage';

export const siteRoutes: readonly RouteObject[] = [
  { path: '/site/:orgSlug/news', element: <SiteNewsPage /> },
  { path: '/site/:orgSlug', element: <SitePage /> },
  { path: '/site/:orgSlug/*', element: <SitePage /> },
];
