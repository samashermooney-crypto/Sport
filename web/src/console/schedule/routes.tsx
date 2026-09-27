import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { useParams } from 'react-router';

import { ConsoleShell } from '../../ui/ConsoleShell';
import { RouteLoading } from '../../ui/RouteLoading';

const CoachGameDay = lazy(() =>
  import('./CoachGameDay').then(({ CoachGameDay: Component }) => ({
    default: Component,
  })),
);
const ScheduleConsole = lazy(() =>
  import('./ScheduleConsole').then(({ ScheduleConsole: Component }) => ({
    default: Component,
  })),
);

function ScheduleRoute(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  return orgId ? (
    <ConsoleShell orgId={orgId}>
      <Suspense fallback={<RouteLoading label="Loading schedule…" />}>
        <ScheduleConsole orgId={orgId} />
      </Suspense>
    </ConsoleShell>
  ) : (
    <main className="schedule-page">Organization not found.</main>
  );
}

function GameDayRoute(): React.JSX.Element {
  const { orgId, eventId } = useParams<{ orgId: string; eventId: string }>();
  return orgId && eventId ? (
    <ConsoleShell orgId={orgId}>
      <Suspense fallback={<RouteLoading label="Loading game day…" />}>
        <CoachGameDay orgId={orgId} eventId={eventId} />
      </Suspense>
    </ConsoleShell>
  ) : (
    <main className="schedule-page">Game not found.</main>
  );
}

export const consoleScheduleRoutes: readonly RouteObject[] = [
  { path: '/console/orgs/:orgId/schedule', element: <ScheduleRoute /> },
  {
    path: '/console/orgs/:orgId/schedule/events/:eventId/game-day',
    element: <GameDayRoute />,
  },
];
