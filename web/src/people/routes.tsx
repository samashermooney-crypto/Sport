import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';

const PeopleList = lazy(() =>
  import('./PeopleConsole').then(({ PeopleList: Component }) => ({
    default: Component,
  })),
);
const AcceptGuardianInvitation = lazy(() =>
  import('./AcceptGuardianInvitation').then(
    ({ AcceptGuardianInvitation: Component }) => ({
      default: Component,
    }),
  ),
);
const FamilyHome = lazy(() =>
  import('./FamilyHome').then(({ FamilyHome: Component }) => ({
    default: Component,
  })),
);
const AcceptPersonClaim = lazy(() =>
  import('./AcceptPersonClaim').then(({ AcceptPersonClaim: Component }) => ({
    default: Component,
  })),
);
const PersonDetail = lazy(() =>
  import('./PeopleConsole').then(({ PersonDetail: Component }) => ({
    default: Component,
  })),
);
const HouseholdsList = lazy(() =>
  import('./HouseholdsConsole').then(({ HouseholdsList: Component }) => ({
    default: Component,
  })),
);
const HouseholdDetail = lazy(() =>
  import('./HouseholdsConsole').then(({ HouseholdDetail: Component }) => ({
    default: Component,
  })),
);

export const peopleRoutes: readonly RouteObject[] = [
  {
    path: '/claim-person/:orgId/:token',
    element: (
      <Suspense fallback={<main role="status">Loading invitation…</main>}>
        <AcceptPersonClaim />
      </Suspense>
    ),
  },
  {
    path: '/me/family',
    element: (
      <Suspense fallback={<main role="status">Loading family…</main>}>
        <FamilyHome />
      </Suspense>
    ),
  },
  {
    path: '/guardian-invitations/:orgId/:token',
    element: (
      <Suspense fallback={<main role="status">Loading invitation…</main>}>
        <AcceptGuardianInvitation />
      </Suspense>
    ),
  },
  {
    path: '/console/orgs/:orgId/households',
    element: (
      <Suspense fallback={<main role="status">Loading households…</main>}>
        <HouseholdsList />
      </Suspense>
    ),
  },
  {
    path: '/console/orgs/:orgId/households/:householdId',
    element: (
      <Suspense fallback={<main role="status">Loading household…</main>}>
        <HouseholdDetail />
      </Suspense>
    ),
  },
  {
    path: '/console/orgs/:orgId/people',
    element: (
      <Suspense fallback={<main role="status">Loading people…</main>}>
        <PeopleList />
      </Suspense>
    ),
  },
  {
    path: '/console/orgs/:orgId/people/:personId',
    element: (
      <Suspense fallback={<main role="status">Loading person…</main>}>
        <PersonDetail />
      </Suspense>
    ),
  },
];
