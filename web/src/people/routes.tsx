import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';

const PeopleList = lazy(() =>
  import('./PeopleConsole').then(({ PeopleList: Component }) => ({
    default: Component,
  })),
);
const ImportsConsole = lazy(() =>
  import('./ImportsConsole').then(({ ImportsConsole: Component }) => ({
    default: Component,
  })),
);
const AcceptAthleteInvitation = lazy(() =>
  import('./AcceptAthleteInvitation').then(
    ({ AcceptAthleteInvitation: Component }) => ({
      default: Component,
    }),
  ),
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
const FamilyProfile = lazy(() =>
  import('./FamilyProfile').then(({ FamilyProfile: Component }) => ({
    default: Component,
  })),
);
const FamilyMedical = lazy(() =>
  import('./FamilyMedical').then(({ FamilyMedical: Component }) => ({
    default: Component,
  })),
);
const FamilyForms = lazy(() =>
  import('./FamilyForms').then(({ FamilyForms: Component }) => ({
    default: Component,
  })),
);
const FamilyWaivers = lazy(() =>
  import('./FamilyWaivers').then(({ FamilyWaivers: Component }) => ({
    default: Component,
  })),
);
const FamilyDocuments = lazy(() =>
  import('./FamilyDocuments').then(({ FamilyDocuments: Component }) => ({
    default: Component,
  })),
);
const FormsConsole = lazy(() =>
  import('./FormsConsole').then(({ FormsConsole: Component }) => ({
    default: Component,
  })),
);
const WaiversConsole = lazy(() =>
  import('./WaiversConsole').then(({ WaiversConsole: Component }) => ({
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
    path: '/me/family/:orgId/:personId/profile',
    element: (
      <Suspense fallback={<main role="status">Loading profile…</main>}>
        <FamilyProfile />
      </Suspense>
    ),
  },
  {
    path: '/me/family/:orgId/:personId/medical',
    element: (
      <Suspense fallback={<main role="status">Loading medical profile…</main>}>
        <FamilyMedical />
      </Suspense>
    ),
  },
  {
    path: '/me/family/:orgId/:personId/forms',
    element: (
      <Suspense fallback={<main role="status">Loading forms…</main>}>
        <FamilyForms />
      </Suspense>
    ),
  },
  {
    path: '/me/family/:orgId/:personId/waivers',
    element: (
      <Suspense fallback={<main role="status">Loading waivers…</main>}>
        <FamilyWaivers />
      </Suspense>
    ),
  },
  {
    path: '/me/family/:orgId/:personId/documents',
    element: (
      <Suspense fallback={<main role="status">Loading documents…</main>}>
        <FamilyDocuments />
      </Suspense>
    ),
  },
  {
    path: '/athlete-invitations/:orgId/:token',
    element: (
      <Suspense fallback={<main role="status">Loading invitation…</main>}>
        <AcceptAthleteInvitation />
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
    path: '/console/orgs/:orgId/imports',
    element: (
      <Suspense fallback={<main role="status">Loading imports…</main>}>
        <ImportsConsole />
      </Suspense>
    ),
  },
  {
    path: '/console/orgs/:orgId/forms',
    element: (
      <Suspense fallback={<main role="status">Loading forms…</main>}>
        <FormsConsole />
      </Suspense>
    ),
  },
  {
    path: '/console/orgs/:orgId/waivers',
    element: (
      <Suspense fallback={<main role="status">Loading waivers…</main>}>
        <WaiversConsole />
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
  {
    path: '/console/orgs/:orgId/people/:personId/medical',
    element: (
      <Suspense fallback={<main role="status">Loading medical profile…</main>}>
        <FamilyMedical />
      </Suspense>
    ),
  },
];
