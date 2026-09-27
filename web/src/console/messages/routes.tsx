import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

const MessagesConsole = lazy(() =>
  import('./MessagesConsole').then(({ MessagesConsole: Component }) => ({
    default: Component,
  })),
);
const PersonMessageHistory = lazy(() =>
  import('./PersonMessageHistory').then(
    ({ PersonMessageHistory: Component }) => ({ default: Component }),
  ),
);
const HouseholdMessageHistory = lazy(() =>
  import('./HouseholdMessageHistory').then(
    ({ HouseholdMessageHistory: Component }) => ({ default: Component }),
  ),
);

function MessagesRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <Suspense fallback={<main role="status">Loading messages…</main>}>
      <MessagesConsole orgId={orgId} />
    </Suspense>
  ) : (
    <main>Organization not found.</main>
  );
}

function PersonMessageHistoryRoute(): React.JSX.Element {
  const { orgId, personId } = useParams<{ orgId: string; personId: string }>();
  return orgId && personId ? (
    <Suspense fallback={<main role="status">Loading messages…</main>}>
      <PersonMessageHistory orgId={orgId} personId={personId} />
    </Suspense>
  ) : (
    <main>Person not found.</main>
  );
}

function HouseholdMessageHistoryRoute(): React.JSX.Element {
  const { orgId, householdId } = useParams<{
    orgId: string;
    householdId: string;
  }>();
  return orgId && householdId ? (
    <Suspense fallback={<main role="status">Loading messages…</main>}>
      <HouseholdMessageHistory orgId={orgId} householdId={householdId} />
    </Suspense>
  ) : (
    <main>Household not found.</main>
  );
}

export const messagesConsoleRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/messages', element: <MessagesRoute /> },
  {
    path: '/console/orgs/:orgId/people/:personId/messages',
    element: <PersonMessageHistoryRoute />,
  },
  {
    path: '/console/orgs/:orgId/households/:householdId/messages',
    element: <HouseholdMessageHistoryRoute />,
  },
];
