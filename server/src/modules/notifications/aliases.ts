import express from 'express';

import type { AuthDependencies } from '../auth/routes';

import { createNotificationHandlers } from './handlers';

function baseRouter(): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  return router;
}

export function createOrgNotificationRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = baseRouter();
  const handlers = createNotificationHandlers(dependencies);
  router.get('/:orgId/notifications', handlers.inbox);
  router.patch('/:orgId/notifications/:id/read', handlers.markRead);
  router.get('/:orgId/notifications/inbox', handlers.inbox);
  router.patch('/:orgId/notifications/inbox/:id/read', handlers.markRead);
  router.get('/:orgId/notifications/preferences', handlers.preferences);
  router.put(
    '/:orgId/notifications/preferences/:category/:channel',
    handlers.updatePreference,
  );
  router.get('/:orgId/notification-preferences', handlers.preferences);
  router.put(
    '/:orgId/notification-preferences/:category/:channel',
    handlers.updatePreference,
  );
  return router;
}

export function createMeNotificationRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = baseRouter();
  const handlers = createNotificationHandlers(dependencies);
  router.get('/notifications', handlers.inbox);
  router.patch('/notifications/:id/read', handlers.markRead);
  router.get('/notification-preferences', handlers.preferences);
  router.put(
    '/notification-preferences/:category/:channel',
    handlers.updatePreference,
  );
  return router;
}
