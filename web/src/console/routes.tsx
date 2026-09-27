import { ConsoleHome } from './Home';
import { auditConsoleRoutes } from './audit/routes';
import { messagesConsoleRoutes } from './messages/routes';
import { moneyConsoleRoutes } from './money/routes';
import { consoleSafetyRoutes } from './safety/routes';

export const consoleRoutes = [
  { path: '/console/orgs/:orgId', element: <ConsoleHome /> },
  ...auditConsoleRoutes,
  ...messagesConsoleRoutes,
  ...moneyConsoleRoutes,
  ...consoleSafetyRoutes,
];
