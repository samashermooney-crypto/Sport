import { ConsoleHome } from './Home';
import { auditConsoleRoutes } from './audit/routes';

export const consoleRoutes = [
  { path: '/console/orgs/:orgId', element: <ConsoleHome /> },
  ...auditConsoleRoutes,
];
