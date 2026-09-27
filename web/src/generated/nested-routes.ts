import type { RouteObject } from 'react-router';

import { consoleAuditRoutes } from '../console/audit/routes';
import { consoleHelpRoutes } from '../console/help/routes';
import { consoleMessagesRoutes } from '../console/messages/routes';
import { consoleMoneyRoutes } from '../console/money/routes';
import { consoleOnboardingRoutes } from '../console/onboarding/routes';
import { consoleSafetyRoutes } from '../console/safety/routes';
import { portalHelpRoutes } from '../portal/help/routes';
import { portalMessagesRoutes } from '../portal/messages/routes';
import { portalMoneyRoutes } from '../portal/money/routes';
import { portalNotificationsRoutes } from '../portal/notifications/routes';
import { portalSafetyRoutes } from '../portal/safety/routes';

export const webNestedRoutes: readonly RouteObject[] = [
  consoleAuditRoutes,
  consoleHelpRoutes,
  consoleMessagesRoutes,
  consoleMoneyRoutes,
  consoleOnboardingRoutes,
  consoleSafetyRoutes,
  portalHelpRoutes,
  portalMessagesRoutes,
  portalMoneyRoutes,
  portalNotificationsRoutes,
  portalSafetyRoutes,
].flat();
