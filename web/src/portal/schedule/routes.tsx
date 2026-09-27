import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { FamilySchedule } from './FamilySchedule';
import { PublicFacilityPage } from './PublicFacilityPage';
import { PublicTournamentPage } from './PublicTournamentPage';

function FamilyScheduleRoute(): React.JSX.Element {
  const { orgId, teamSeasonId, personId } = useParams<{
    orgId: string;
    teamSeasonId: string;
    personId: string;
  }>();
  return orgId && teamSeasonId && personId ? (
    <FamilySchedule
      orgId={orgId}
      teamSeasonId={teamSeasonId}
      personId={personId}
    />
  ) : (
    <main className="schedule-page">
      Choose a team and athlete to view this schedule.
    </main>
  );
}

function PublicFacilityRoute(): React.JSX.Element {
  const { slug, facilityId } = useParams<{
    slug: string;
    facilityId: string;
  }>();
  return slug && facilityId ? (
    <PublicFacilityPage slug={slug} facilityId={facilityId} />
  ) : (
    <main className="schedule-page">Facility not found.</main>
  );
}

function PublicTournamentRoute(): React.JSX.Element {
  const { slug, bracketId } = useParams<{ slug: string; bracketId: string }>();
  return slug && bracketId ? (
    <PublicTournamentPage slug={slug} bracketId={bracketId} />
  ) : (
    <main className="schedule-page">Tournament not found.</main>
  );
}

export const schedulePortalRoutes: readonly RouteObject[] = [
  {
    path: '/portal/orgs/:orgId/schedule/teams/:teamSeasonId/people/:personId',
    element: <FamilyScheduleRoute />,
  },
  {
    path: '/orgs/:slug/facilities/:facilityId',
    element: <PublicFacilityRoute />,
  },
  {
    path: '/orgs/:slug/tournaments/:bracketId',
    element: <PublicTournamentRoute />,
  },
];
