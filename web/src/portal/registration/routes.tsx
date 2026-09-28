import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const Catalog = lazy(() =>
  import('./RegistrationScreen').then(({ RegistrationScreen: component }) => ({
    default: component,
  })),
);
const Checkout = lazy(() =>
  import('./CheckoutReviewScreen').then(
    ({ CheckoutReviewScreen: component }) => ({ default: component }),
  ),
);
const Requirements = lazy(() =>
  import('./CheckoutRequirementsScreen').then(
    ({ CheckoutRequirementsScreen: component }) => ({ default: component }),
  ),
);
const MyRegistrations = lazy(() =>
  import('./MyRegistrationsScreen').then(
    ({ MyRegistrationsScreen: component }) => ({ default: component }),
  ),
);
const TeamEntries = lazy(() =>
  import('./TeamEntriesScreen').then(({ TeamEntriesScreen: component }) => ({
    default: component,
  })),
);
const TeamEntryInvite = lazy(() =>
  import('./TeamEntryInviteScreen').then(
    ({ TeamEntryInviteScreen: component }) => ({ default: component }),
  ),
);

function CatalogRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  if (!orgId) return <main>Organization not found.</main>;
  return (
    <Suspense fallback={<p role="status">Loading registration…</p>}>
      <Catalog orgId={orgId} />
    </Suspense>
  );
}

function CheckoutRoute(): React.JSX.Element {
  const { orgId, checkoutId } = useParams<{
    orgId: string;
    checkoutId: string;
  }>();
  if (!orgId || !checkoutId) return <main>Checkout not found.</main>;
  return (
    <Suspense fallback={<p role="status">Loading checkout…</p>}>
      <Checkout orgId={orgId} checkoutId={checkoutId} />
    </Suspense>
  );
}

function RequirementsRoute(): React.JSX.Element {
  const { orgId, checkoutId } = useParams<{
    orgId: string;
    checkoutId: string;
  }>();
  if (!orgId || !checkoutId) return <main>Checkout not found.</main>;
  return (
    <Suspense fallback={<p role="status">Loading participant details…</p>}>
      <Requirements orgId={orgId} checkoutId={checkoutId} />
    </Suspense>
  );
}

function MyRegistrationsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  if (!orgId) return <main>Organization not found.</main>;
  return (
    <Suspense fallback={<p role="status">Loading registrations…</p>}>
      <MyRegistrations orgId={orgId} />
    </Suspense>
  );
}

function TeamEntriesRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  if (!orgId) return <main>Organization not found.</main>;
  return (
    <Suspense fallback={<p role="status">Loading team registration…</p>}>
      <TeamEntries orgId={orgId} />
    </Suspense>
  );
}

function TeamEntryInviteRoute(): React.JSX.Element {
  const { orgId, token } = useParams<{ orgId: string; token: string }>();
  if (!orgId || !token) return <main>Team invitation not found.</main>;
  return (
    <Suspense fallback={<p role="status">Loading team invitation…</p>}>
      <TeamEntryInvite orgId={orgId} token={token} />
    </Suspense>
  );
}

export const portalRegistrationRoutes: readonly RouteObject[] = [
  { path: '/portal/orgs/:orgId/register', element: <CatalogRoute /> },
  {
    path: '/portal/orgs/:orgId/registrations',
    element: <MyRegistrationsRoute />,
  },
  {
    path: '/portal/orgs/:orgId/team-entry',
    element: <TeamEntriesRoute />,
  },
  {
    path: '/portal/orgs/:orgId/team-entry-invites/:token',
    element: <TeamEntryInviteRoute />,
  },
  {
    path: '/portal/orgs/:orgId/register/checkouts/:checkoutId/requirements',
    element: <RequirementsRoute />,
  },
  {
    path: '/portal/orgs/:orgId/register/checkouts/:checkoutId',
    element: <CheckoutRoute />,
  },
];
