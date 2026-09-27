import type { RouteObject } from 'react-router';

import { consoleAuditRoutes } from '../console/audit/routes';
import { consoleFacilitiesRoutes } from '../console/facilities/routes';
import { consoleMessagesRoutes } from '../console/messages/routes';
import { consoleMoneyRoutes } from '../console/money/routes';
import { consoleProgramsRoutes } from '../console/programs/routes';
import { consoleSafetyRoutes } from '../console/safety/routes';
import { consoleTeamsRoutes } from '../console/teams/routes';
import { portalMessagesRoutes } from '../portal/messages/routes';
import { portalMoneyRoutes } from '../portal/money/routes';
import { portalNotificationsRoutes } from '../portal/notifications/routes';
import { portalSafetyRoutes } from '../portal/safety/routes';

export const webNestedRoutes: readonly RouteObject[] = [
  consoleAuditRoutes,
  consoleFacilitiesRoutes,
  consoleMessagesRoutes,
  consoleMoneyRoutes,
  consoleProgramsRoutes,
  consoleSafetyRoutes,
  consoleTeamsRoutes,
  portalMessagesRoutes,
  portalMoneyRoutes,
  portalNotificationsRoutes,
  portalSafetyRoutes,
].flat();
