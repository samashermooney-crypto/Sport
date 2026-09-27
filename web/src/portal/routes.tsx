import { messagesPortalRoutes } from './messages/routes';
import { notificationPortalRoutes } from './notifications/routes';

export const portalRoutes = [
  ...notificationPortalRoutes,
  ...messagesPortalRoutes,
];
