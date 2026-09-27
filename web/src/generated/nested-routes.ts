import type { RouteObject } from 'react-router';

import { consoleAuditRoutes } from '../console/audit/routes';
import { consoleEvaluationsRoutes } from '../console/evaluations/routes';
import { consoleMessagesRoutes } from '../console/messages/routes';
import { consoleMoneyRoutes } from '../console/money/routes';
import { consoleSafetyRoutes } from '../console/safety/routes';
import { consoleScheduleRoutes } from '../console/schedule/routes';
import { portalEvaluationsRoutes } from '../portal/evaluations/routes';
import { portalMessagesRoutes } from '../portal/messages/routes';
import { portalMoneyRoutes } from '../portal/money/routes';
import { portalNotificationsRoutes } from '../portal/notifications/routes';
import { portalSafetyRoutes } from '../portal/safety/routes';
import { portalScheduleRoutes } from '../portal/schedule/routes';

export const webNestedRoutes: readonly RouteObject[] = [
  consoleAuditRoutes,
  consoleEvaluationsRoutes,
  consoleMessagesRoutes,
  consoleMoneyRoutes,
  consoleSafetyRoutes,
  consoleScheduleRoutes,
  portalEvaluationsRoutes,
  portalMessagesRoutes,
  portalMoneyRoutes,
  portalNotificationsRoutes,
  portalSafetyRoutes,
  portalScheduleRoutes,
].flat();
