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

export const registrationPortalRoutes: readonly RouteObject[] = [
  { path: '/portal/orgs/:orgId/register', element: <CatalogRoute /> },
  {
    path: '/portal/orgs/:orgId/register/checkouts/:checkoutId',
    element: <CheckoutRoute />,
  },
];
