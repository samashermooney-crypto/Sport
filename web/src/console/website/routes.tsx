import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { WebsiteConsole } from './WebsiteConsole';
import { WebsiteContactsConsole } from './WebsiteContactsConsole';
import { WebsiteDomainsConsole } from './WebsiteDomainsConsole';
import { WebsiteEmbedsConsole } from './WebsiteEmbedsConsole';
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

function WebsiteDomainsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <WebsiteDomainsConsole orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

function WebsiteEmbedsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <WebsiteEmbedsConsole orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

function WebsiteContactsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <WebsiteContactsConsole orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

export const consoleWebsiteRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/website', element: <WebsiteRoute /> },
  {
    path: '/console/orgs/:orgId/website/contacts',
    element: <WebsiteContactsRoute />,
  },
  {
    path: '/console/orgs/:orgId/website/settings',
    element: <WebsiteSettingsRoute />,
  },
  {
    path: '/console/orgs/:orgId/website/news',
    element: <WebsiteNewsRoute />,
  },
  {
    path: '/console/orgs/:orgId/website/domains',
    element: <WebsiteDomainsRoute />,
  },
  {
    path: '/console/orgs/:orgId/website/embeds',
    element: <WebsiteEmbedsRoute />,
  },
];
