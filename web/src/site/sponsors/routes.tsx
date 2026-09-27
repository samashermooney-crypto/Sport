import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const PublicSponsorsPage = lazy(() =>
  import('./PublicSponsors').then(({ PublicSponsors: Component }) => ({
    default: Component,
  })),
);

function PublicSponsorsRoute(): React.JSX.Element {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return orgSlug ? (
    <Suspense fallback={<main role="status">Loading sponsors…</main>}>
      <PublicSponsorsPage orgSlug={orgSlug} surface="website_home" />
    </Suspense>
  ) : (
    <main>Sponsors not found.</main>
  );
}

export const siteSponsorsRoutes: readonly RouteObject[] = [
  {
    path: '/site/:orgSlug/sponsors',
    element: <PublicSponsorsRoute />,
  },
];
