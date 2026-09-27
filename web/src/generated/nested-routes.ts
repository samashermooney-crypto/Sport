import type { RouteObject } from 'react-router';

import { consoleAiRoutes } from '../console/ai/routes';
import { consoleAuditRoutes } from '../console/audit/routes';
import { consoleImportsRoutes } from '../console/imports/routes';
import { consoleMessagesRoutes } from '../console/messages/routes';
import { consoleMoneyRoutes } from '../console/money/routes';
import { consoleSafetyRoutes } from '../console/safety/routes';
import { portalMessagesRoutes } from '../portal/messages/routes';
import { portalMoneyRoutes } from '../portal/money/routes';
import { portalNotificationsRoutes } from '../portal/notifications/routes';
import { portalSafetyRoutes } from '../portal/safety/routes';

export const webNestedRoutes: readonly RouteObject[] = [
  consoleAiRoutes,
  consoleAuditRoutes,
  consoleImportsRoutes,
  consoleMessagesRoutes,
  consoleMoneyRoutes,
  consoleSafetyRoutes,
  portalMessagesRoutes,
  portalMoneyRoutes,
  portalNotificationsRoutes,
  portalSafetyRoutes,
].flat();
