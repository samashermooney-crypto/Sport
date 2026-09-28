import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { WebsiteConsole } from './WebsiteConsole';
import { WebsiteNewsConsole } from './WebsiteNewsConsole';
import { WebsiteSettingsConsole } from './WebsiteSettingsConsole';

function WebsiteRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <WebsiteConsole orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

function WebsiteSettingsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <WebsiteSettingsConsole orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

function WebsiteNewsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <WebsiteNewsConsole orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

export const consoleWebsiteRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/website', element: <WebsiteRoute /> },
  {
    path: '/console/orgs/:orgId/website/settings',
    element: <WebsiteSettingsRoute />,
  },
  {
    path: '/console/orgs/:orgId/website/news',
    element: <WebsiteNewsRoute />,
  },
];
