import { ConsoleHome } from './Home';
import { auditConsoleRoutes } from './audit/routes';
import { messagesConsoleRoutes } from './messages/routes';
import { consoleSafetyRoutes } from './safety/routes';

export const consoleRoutes = [
  { path: '/console/orgs/:orgId', element: <ConsoleHome /> },
  ...auditConsoleRoutes,
  ...messagesConsoleRoutes,
  ...consoleSafetyRoutes,
];
