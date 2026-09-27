import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';

const PeopleList = lazy(() =>
  import('./PeopleConsole').then(({ PeopleList: Component }) => ({
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
