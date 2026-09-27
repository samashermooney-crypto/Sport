import type { RouteObject } from 'react-router';

import { consoleAuditRoutes } from '../console/audit/routes';
import { consoleMessagesRoutes } from '../console/messages/routes';
import { consoleMoneyRoutes } from '../console/money/routes';
import { consoleReportsRoutes } from '../console/reports/routes';
import { consoleSafetyRoutes } from '../console/safety/routes';
import { consoleScheduleRoutes } from '../console/schedule/routes';
import { portalMessagesRoutes } from '../portal/messages/routes';
import { portalMoneyRoutes } from '../portal/money/routes';
import { portalNotificationsRoutes } from '../portal/notifications/routes';
import { portalSafetyRoutes } from '../portal/safety/routes';
import { portalScheduleRoutes } from '../portal/schedule/routes';

export const webNestedRoutes: readonly RouteObject[] = [
  consoleAuditRoutes,
  consoleMessagesRoutes,
  consoleMoneyRoutes,
  consoleReportsRoutes,
  consoleSafetyRoutes,
  consoleScheduleRoutes,
  portalMessagesRoutes,
  portalMoneyRoutes,
  portalNotificationsRoutes,
  portalSafetyRoutes,
  portalScheduleRoutes,
].flat();
