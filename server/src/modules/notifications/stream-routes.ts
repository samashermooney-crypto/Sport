import { apiErrorSchema } from '@shared/schemas/errors';
import express from 'express';

import { listenSse } from '../../lib/sse';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { notificationChannel, notificationStreamEvent } from './stream';

export function createStreamRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.get('/', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      await listenSse(response, {
        connectionString:
          process.env.DATABASE_URL ??
          'postgres://athlentry_app@127.0.0.1:5432/athlentry_dev',
        channel: notificationChannel,
        accept: (payload) =>
          notificationStreamEvent(payload, session.accountId),
        authorize: async () => {
          try {
            const current = await requireSession(dependencies, request);
            return current.id === session.id;
          } catch {
            return false;
          }
        },
      });
    } catch (error) {
      if (!response.headersSent) {
        const status =
          error instanceof Error && 'status' in error && error.status === 401
            ? 401
            : 503;
        response.status(status).json(
          apiErrorSchema.parse({
            error: {
              code:
                status === 401 ? 'UNAUTHENTICATED' : 'DEPENDENCY_UNAVAILABLE',
              message:
                status === 401 ? 'Sign in to continue' : 'Stream unavailable',
            },
          }),
        );
      }
    }
  });
  return router;
}
