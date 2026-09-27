import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { CoachGameDay } from './CoachGameDay';
import { ScheduleConsole } from './ScheduleConsole';

function ScheduleRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <ScheduleConsole orgId={orgId} />
  ) : (
    <main className="schedule-page">Organization not found.</main>
  );
}

function GameDayRoute(): React.JSX.Element {
  const { orgId, eventId } = useParams<{ orgId: string; eventId: string }>();
  return orgId && eventId ? (
    <CoachGameDay orgId={orgId} eventId={eventId} />
  ) : (
    <main className="schedule-page">Game not found.</main>
  );
}

export const scheduleConsoleRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/schedule', element: <ScheduleRoute /> },
  {
    path: '/console/orgs/:orgId/schedule/events/:eventId/game-day',
    element: <GameDayRoute />,
  },
];
