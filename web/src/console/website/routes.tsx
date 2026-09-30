import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const WebsiteConsole = lazy(() =>
  import('./WebsiteConsole').then(({ WebsiteConsole: component }) => ({
    default: component,
  })),
);
const WebsiteContactsConsole = lazy(() =>
  import('./WebsiteContactsConsole').then(
    ({ WebsiteContactsConsole: component }) => ({ default: component }),
  ),
);
const WebsiteDomainsConsole = lazy(() =>
  import('./WebsiteDomainsConsole').then(
    ({ WebsiteDomainsConsole: component }) => ({ default: component }),
  ),
);
const WebsiteEmbedsConsole = lazy(() =>
  import('./WebsiteEmbedsConsole').then(
    ({ WebsiteEmbedsConsole: component }) => ({ default: component }),
  ),
);
const WebsiteNewsConsole = lazy(() =>
  import('./WebsiteNewsConsole').then(({ WebsiteNewsConsole: component }) => ({
    default: component,
  })),
);
const WebsiteSettingsConsole = lazy(() =>
  import('./WebsiteSettingsConsole').then(
    ({ WebsiteSettingsConsole: component }) => ({ default: component }),
  ),
);

function WebsiteRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading website…</main>}>
      <WebsiteConsole orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

function WebsiteSettingsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading website settings…</main>}>
      <WebsiteSettingsConsole orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

function WebsiteNewsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading website news…</main>}>
      <WebsiteNewsConsole orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

function WebsiteDomainsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading website domains…</main>}>
      <WebsiteDomainsConsole orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

function WebsiteEmbedsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading website embeds…</main>}>
      <WebsiteEmbedsConsole orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

function WebsiteContactsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading website contacts…</main>}>
      <WebsiteContactsConsole orgId={orgId} />
    </Suspense>
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
