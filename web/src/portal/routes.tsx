import { messagesPortalRoutes } from './messages/routes';
import { notificationPortalRoutes } from './notifications/routes';
import { portalSafetyRoutes } from './safety/routes';

export const portalRoutes = [
  ...notificationPortalRoutes,
  ...messagesPortalRoutes,
  ...portalSafetyRoutes,
];
