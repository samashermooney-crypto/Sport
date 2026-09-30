import { useParams } from 'react-router';
import type { RouteObject } from 'react-router';

import { PublicFacilityPage } from '../portal/schedule/PublicFacilityPage';
import { PublicStandingsPage } from '../portal/schedule/PublicStandingsPage';
import { PublicTournamentPage } from '../portal/schedule/PublicTournamentPage';

import { PublicSiteFacilitiesPage } from './PublicFacilitiesPage';
import { SiteNewsPage } from './SiteNewsPage';
import { SitePage } from './SitePage';
import { WebsiteEmbedPage } from './WebsiteEmbedPage';

export const siteRoutes: readonly RouteObject[] = [
  { path: '/embed/:orgSlug/:publicKey', element: <WebsiteEmbedPage /> },
  { path: '/site/:orgSlug/news', element: <SiteNewsPage /> },
  {
    path: '/site/:orgSlug/facilities',
    element: <PublicSiteFacilitiesPage />,
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
  { path: '/site/:orgSlug', element: <SitePage /> },
  { path: '/site/:orgSlug/*', element: <SitePage /> },
];

function PublicSiteStandingsPage(): React.JSX.Element {
  const { orgSlug, programId } = useParams<{
    orgSlug: string;
    programId: string;
  }>();
  return orgSlug && programId ? (
    <PublicStandingsPage
      slug={orgSlug}
      scopeType="program"
      scopeId={programId}
    />
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
    <PublicTournamentPage slug={orgSlug} bracketId={bracketId} />
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
    <PublicFacilityPage slug={orgSlug} facilityId={facilityId} />
  ) : (
    <main role="alert">Facility not found.</main>
  );
}
