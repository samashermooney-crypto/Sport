import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { RouteLoading } from '../../ui/RouteLoading';
import { PortalShell } from '../PortalShell';

const FamilySchedule = lazy(() =>
  import('./FamilySchedule').then(({ FamilySchedule: Component }) => ({
    default: Component,
  })),
);
const LiveContestPage = lazy(() =>
  import('./LiveContestPage').then(({ LiveContestPage: Component }) => ({
    default: Component,
  })),
);
const OfficialAssignmentsPortal = lazy(() =>
  import('./OfficialAssignmentsPortal').then(
    ({ OfficialAssignmentsPortal: Component }) => ({ default: Component }),
  ),
);
const PracticeSlotPicker = lazy(() =>
  import('./PracticeSlotPicker').then(({ PracticeSlotPicker: Component }) => ({
    default: Component,
  })),
);
const PublicFacilityPage = lazy(() =>
  import('./PublicFacilityPage').then(({ PublicFacilityPage: Component }) => ({
    default: Component,
  })),
);
const PublicStandingsPage = lazy(() =>
  import('./PublicStandingsPage').then(
    ({ PublicStandingsPage: Component }) => ({
      default: Component,
    }),
  ),
);
const PublicTournamentPage = lazy(() =>
  import('./PublicTournamentPage').then(
    ({ PublicTournamentPage: Component }) => ({ default: Component }),
  ),
);

function loading(element: React.ReactNode): React.JSX.Element {
  return (
    <Suspense fallback={<RouteLoading label="Loading schedule…" />}>
      {element}
    </Suspense>
  );
}

function FamilyScheduleRoute(): React.JSX.Element {
  const { orgId, teamSeasonId, personId } = useParams<{
    orgId: string;
    teamSeasonId: string;
    personId: string;
  }>();
  return orgId && teamSeasonId && personId ? (
    <PortalShell orgId={orgId}>
      {loading(
        <FamilySchedule
          orgId={orgId}
          teamSeasonId={teamSeasonId}
          personId={personId}
        />,
      )}
    </PortalShell>
  ) : (
    <main className="schedule-page">
      Choose a team and athlete to view this schedule.
    </main>
  );
}

function PracticeSlotPickerRoute(): React.JSX.Element {
  const { orgId, teamSeasonId } = useParams<{
    orgId: string;
    teamSeasonId: string;
  }>();
  return orgId && teamSeasonId ? (
    loading(<PracticeSlotPicker orgId={orgId} teamSeasonId={teamSeasonId} />)
  ) : (
    <main className="schedule-page">
      Choose a team to request practice time.
    </main>
  );
}

function OfficialAssignmentsRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    loading(<OfficialAssignmentsPortal orgId={orgId} />)
  ) : (
    <main className="schedule-page">Organization not found.</main>
  );
}

function PublicFacilityRoute(): React.JSX.Element {
  const { slug, facilityId } = useParams<{
    slug: string;
    facilityId: string;
  }>();
  return slug && facilityId ? (
    loading(<PublicFacilityPage slug={slug} facilityId={facilityId} />)
  ) : (
    <main className="schedule-page">Facility not found.</main>
  );
}

function PublicTournamentRoute(): React.JSX.Element {
  const { slug, bracketId } = useParams<{ slug: string; bracketId: string }>();
  return slug && bracketId ? (
    loading(<PublicTournamentPage slug={slug} bracketId={bracketId} />)
  ) : (
    <main className="schedule-page">Tournament not found.</main>
  );
}

function LiveContestRoute(): React.JSX.Element {
  const { slug, contestId } = useParams<{ slug: string; contestId: string }>();
  return slug && contestId ? (
    loading(<LiveContestPage slug={slug} contestId={contestId} />)
  ) : (
    <main className="schedule-page">Contest not found.</main>
  );
}

function PublicProgramStandingsRoute(): React.JSX.Element {
  const { slug, programId } = useParams<{ slug: string; programId: string }>();
  return slug && programId ? (
    loading(
      <PublicStandingsPage
        slug={slug}
        scopeType="program"
        scopeId={programId}
      />,
    )
  ) : (
    <main className="schedule-page">Standings not found.</main>
  );
}

function PublicDivisionStandingsRoute(): React.JSX.Element {
  const { slug, divisionId } = useParams<{
    slug: string;
    divisionId: string;
  }>();
  return slug && divisionId ? (
    loading(
      <PublicStandingsPage
        slug={slug}
        scopeType="division"
        scopeId={divisionId}
      />,
    )
  ) : (
    <main className="schedule-page">Standings not found.</main>
  );
}

export const portalScheduleRoutes: readonly RouteObject[] = [
  {
    path: '/portal/orgs/:orgId/schedule/officials',
    element: <OfficialAssignmentsRoute />,
  },
  {
    path: '/portal/orgs/:orgId/schedule/teams/:teamSeasonId/practice-slots',
    element: <PracticeSlotPickerRoute />,
  },
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
  {
    path: '/orgs/:slug/contests/:contestId/live',
    element: <LiveContestRoute />,
  },
  {
    path: '/orgs/:slug/programs/:programId/standings',
    element: <PublicProgramStandingsRoute />,
  },
  {
    path: '/orgs/:slug/divisions/:divisionId/standings',
    element: <PublicDivisionStandingsRoute />,
  },
];
