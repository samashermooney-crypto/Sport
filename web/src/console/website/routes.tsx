import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { WebsiteConsole } from './WebsiteConsole';

function WebsiteRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <WebsiteConsole orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

export const consoleWebsiteRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/website', element: <WebsiteRoute /> },
];
