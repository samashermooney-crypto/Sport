import type { RouteObject } from 'react-router';

import { SiteNewsPage } from './SiteNewsPage';
import { SitePage } from './SitePage';
import { WebsiteEmbedPage } from './WebsiteEmbedPage';

export const siteRoutes: readonly RouteObject[] = [
  { path: '/embed/:orgSlug/:publicKey', element: <WebsiteEmbedPage /> },
  { path: '/site/:orgSlug/news', element: <SiteNewsPage /> },
  { path: '/site/:orgSlug', element: <SitePage /> },
  { path: '/site/:orgSlug/*', element: <SitePage /> },
];
