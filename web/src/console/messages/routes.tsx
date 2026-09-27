import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { HouseholdMessageHistory } from './HouseholdMessageHistory';
import { MessagesConsole } from './MessagesConsole';
import { PersonMessageHistory } from './PersonMessageHistory';

function MessagesRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <MessagesConsole orgId={orgId} />
  ) : (
    <main>Organization not found.</main>
  );
}

function PersonMessageHistoryRoute(): React.JSX.Element {
  const { orgId, personId } = useParams<{ orgId: string; personId: string }>();
  return orgId && personId ? (
    <PersonMessageHistory orgId={orgId} personId={personId} />
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
    <HouseholdMessageHistory orgId={orgId} householdId={householdId} />
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
