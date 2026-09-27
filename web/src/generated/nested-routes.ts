import type { RouteObject } from 'react-router';

import { consoleAuditRoutes } from '../console/audit/routes';
import { consoleClassesRoutes } from '../console/classes/routes';
import { consoleMessagesRoutes } from '../console/messages/routes';
import { consoleMoneyRoutes } from '../console/money/routes';
import { consoleSafetyRoutes } from '../console/safety/routes';
import { portalClassesRoutes } from '../portal/classes/routes';
import { portalMessagesRoutes } from '../portal/messages/routes';
import { portalMoneyRoutes } from '../portal/money/routes';
import { portalNotificationsRoutes } from '../portal/notifications/routes';
import { portalSafetyRoutes } from '../portal/safety/routes';

export const webNestedRoutes: readonly RouteObject[] = [
  consoleAuditRoutes,
  consoleClassesRoutes,
  consoleMessagesRoutes,
  consoleMoneyRoutes,
  consoleSafetyRoutes,
  portalClassesRoutes,
  portalMessagesRoutes,
  portalMoneyRoutes,
  portalNotificationsRoutes,
  portalSafetyRoutes,
].flat();
