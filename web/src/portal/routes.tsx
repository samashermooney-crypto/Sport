import { messagesPortalRoutes } from './messages/routes';
import { moneyPortalRoutes } from './money/routes';
import { notificationPortalRoutes } from './notifications/routes';
import { portalSafetyRoutes } from './safety/routes';

export const portalRoutes = [
  ...notificationPortalRoutes,
  ...messagesPortalRoutes,
  ...moneyPortalRoutes,
  ...portalSafetyRoutes,
];
