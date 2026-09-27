import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const PublicFundraiserPage = lazy(() =>
  import('./PublicFundraiser').then(({ PublicFundraiser: Component }) => ({
    default: Component,
  })),
);

function PublicFundraiserRoute(): React.JSX.Element {
  const { orgSlug, campaignSlug } = useParams<{
    orgSlug: string;
    campaignSlug: string;
  }>();
  return orgSlug && campaignSlug ? (
    <Suspense fallback={<main role="status">Loading fundraiser…</main>}>
      <PublicFundraiser orgSlug={orgSlug} campaignSlug={campaignSlug} />
    </Suspense>
  ) : (
    <main>Fundraiser not found.</main>
  );
}

function PublicFundraiser({
  orgSlug,
  campaignSlug,
}: {
  orgSlug: string;
  campaignSlug: string;
}): React.JSX.Element {
  const Component = PublicFundraiserPage;
  return <Component orgSlug={orgSlug} campaignSlug={campaignSlug} />;
}

export const fundraisingSiteRoutes: readonly RouteObject[] = [
  {
    path: '/site/:orgSlug/fundraisers/:campaignSlug',
    element: <PublicFundraiserRoute />,
  },
];
