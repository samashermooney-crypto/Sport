import express from 'express';

import type { AuthDependencies } from '../auth/routes';

import { createNotificationHandlers } from './handlers';

export function createNotificationsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const handlers = createNotificationHandlers(dependencies);
  router.use(express.json({ limit: '8kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/orgs/:orgId/inbox', handlers.inbox);
  router.patch('/orgs/:orgId/inbox/:id/read', handlers.markRead);
  router.get('/orgs/:orgId/preferences', handlers.preferences);
  router.put(
    '/orgs/:orgId/preferences/:category/:channel',
    handlers.updatePreference,
  );
  return router;
}
