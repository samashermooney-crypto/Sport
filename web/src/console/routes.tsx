import { ConsoleHome } from './Home';
import { aiConsoleRoutes } from './ai/routes';
import { auditConsoleRoutes } from './audit/routes';
import { importsConsoleRoutes } from './imports/routes';
import { messagesConsoleRoutes } from './messages/routes';
import { moneyConsoleRoutes } from './money/routes';
import { consoleSafetyRoutes } from './safety/routes';

export const consoleRoutes = [
  { path: '/console/orgs/:orgId', element: <ConsoleHome /> },
  ...aiConsoleRoutes,
  ...auditConsoleRoutes,
  ...importsConsoleRoutes,
  ...messagesConsoleRoutes,
  ...moneyConsoleRoutes,
  ...consoleSafetyRoutes,
];
