import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import type { RouteObject } from 'react-router';

const PublicFacilityPage = lazy(() =>
  import('../portal/schedule/PublicFacilityPage').then(
    ({ PublicFacilityPage: component }) => ({ default: component }),
  ),
);
const PublicStandingsPage = lazy(() =>
  import('../portal/schedule/PublicStandingsPage').then(
    ({ PublicStandingsPage: component }) => ({ default: component }),
  ),
);
const PublicTournamentPage = lazy(() =>
  import('../portal/schedule/PublicTournamentPage').then(
    ({ PublicTournamentPage: component }) => ({ default: component }),
  ),
);
const PublicSiteFacilitiesPage = lazy(() =>
  import('./PublicFacilitiesPage').then(
    ({ PublicSiteFacilitiesPage: component }) => ({ default: component }),
  ),
);
const PublicSiteNewsPostPage = lazy(() =>
  import('./PublicSiteNewsPostPage').then(
    ({ PublicSiteNewsPostPage: component }) => ({ default: component }),
  ),
);
const SiteNewsPage = lazy(() =>
  import('./SiteNewsPage').then(({ SiteNewsPage: component }) => ({
    default: component,
  })),
);
const SitePage = lazy(() =>
  import('./SitePage').then(({ SitePage: component }) => ({
    default: component,
  })),
);
const WebsiteEmbedPage = lazy(() =>
  import('./WebsiteEmbedPage').then(({ WebsiteEmbedPage: component }) => ({
    default: component,
  })),
);

export const siteRoutes: readonly RouteObject[] = [
  {
    path: '/embed/:orgSlug/:publicKey',
    element: (
      <SiteRouteSuspense>
        <WebsiteEmbedPage />
      </SiteRouteSuspense>
    ),
  },
  {
    path: '/site/:orgSlug/news',
    element: (
      <SiteRouteSuspense>
        <SiteNewsPage />
      </SiteRouteSuspense>
    ),
  },
  {
    path: '/site/:orgSlug/news/:newsSlug',
    element: (
      <SiteRouteSuspense>
        <PublicSiteNewsPostPage />
      </SiteRouteSuspense>
    ),
  },
  {
    path: '/site/:orgSlug/facilities',
    element: (
      <SiteRouteSuspense>
        <PublicSiteFacilitiesPage />
      </SiteRouteSuspense>
    ),
  },
  {
    path: '/site/:orgSlug/standings/:programId',
    element: <PublicSiteStandingsPage />,
  },
  {
    path: '/site/:orgSlug/brackets/:bracketId',
    element: <PublicSiteTournamentPage />,
  },
  {
    path: '/site/:orgSlug/facilities/:facilityId',
    element: <PublicSiteFacilityPage />,
  },
  {
    path: '/site/:orgSlug',
    element: (
      <SiteRouteSuspense>
        <SitePage />
      </SiteRouteSuspense>
    ),
  },
  {
    path: '/site/:orgSlug/*',
    element: (
      <SiteRouteSuspense>
        <SitePage />
      </SiteRouteSuspense>
    ),
  },
];

function SiteRouteSuspense({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation('site');
  return (
    <Suspense
      fallback={
        <main className="public-site-main" role="status">
          {t('loadingWebsite')}
        </main>
      }
    >
      {children}
    </Suspense>
  );
}

function PublicSiteStandingsPage(): React.JSX.Element {
  const { orgSlug, programId } = useParams<{
    orgSlug: string;
    programId: string;
  }>();
  return orgSlug && programId ? (
    <SiteRouteSuspense>
      <PublicStandingsPage
        slug={orgSlug}
        scopeType="program"
        scopeId={programId}
      />
    </SiteRouteSuspense>
  ) : (
    <main role="alert">Standings not found.</main>
  );
}

function PublicSiteTournamentPage(): React.JSX.Element {
  const { orgSlug, bracketId } = useParams<{
    orgSlug: string;
    bracketId: string;
  }>();
  return orgSlug && bracketId ? (
    <SiteRouteSuspense>
      <PublicTournamentPage slug={orgSlug} bracketId={bracketId} />
    </SiteRouteSuspense>
  ) : (
    <main role="alert">Tournament not found.</main>
  );
}

function PublicSiteFacilityPage(): React.JSX.Element {
  const { orgSlug, facilityId } = useParams<{
    orgSlug: string;
    facilityId: string;
  }>();
  return orgSlug && facilityId ? (
    <SiteRouteSuspense>
      <PublicFacilityPage slug={orgSlug} facilityId={facilityId} />
    </SiteRouteSuspense>
  ) : (
    <main role="alert">Facility not found.</main>
  );
}
