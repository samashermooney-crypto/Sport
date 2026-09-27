import { apiErrorSchema } from '@shared/schemas/errors';
import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { parsePageRequest } from '../../lib/pagination';
import { listenSse } from '../../lib/sse';
import { VersionConflictError } from '../../lib/version-check';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { updatePreferenceSchema } from './schema';
import {
  listInbox,
  listPreferences,
  markNotificationRead,
  NotificationAccessError,
  updatePreference,
} from './service';
import { notificationChannel, notificationStreamEvent } from './stream';

function sendError(response: Response, error: unknown): void {
  const status =
    error instanceof NotificationAccessError
      ? 404
      : error instanceof VersionConflictError
        ? 409
        : error instanceof z.ZodError || error instanceof RangeError
          ? 400
          : error instanceof Error && 'status' in error && error.status === 403
            ? 403
            : error instanceof Error &&
                'status' in error &&
                error.status === 401
              ? 401
              : 500;
  const code =
    status === 404
      ? 'NOT_FOUND'
      : status === 409
        ? 'CONFLICT'
        : status === 403
          ? 'FORBIDDEN'
          : status === 400
            ? 'VALIDATION_ERROR'
            : status === 401
              ? 'UNAUTHENTICATED'
              : 'INTERNAL_ERROR';
  response.status(status).json(
    apiErrorSchema.parse({
      error: {
        code,
        message:
          status === 500
            ? 'The request could not be completed'
            : error instanceof Error
              ? error.message
              : 'Request failed',
        ...(error instanceof VersionConflictError
          ? {
              fields: {
                currentVersion: String(
                  (error.current as { version: number }).version,
                ),
              },
            }
          : {}),
      },
    }),
  );
}

function requireWriteOrigin(
  dependencies: AuthDependencies,
  request: Request,
): void {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  if (
    request.get('X-Athlentry-Request') !== '1' ||
    (request.get('Origin') !== new URL(dependencies.appUrl).origin &&
      !(bearer && !request.get('Origin')))
  ) {
    const error = new Error('Request origin could not be verified');
    Object.assign(error, { status: 403 });
    throw error;
  }
}

export function createNotificationsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/orgs/:orgId/inbox', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const query = request.query as Record<string, unknown>;
      const page = parsePageRequest(query, ['created_at'], 'created_at');
      const unreadOnly =
        query.unreadOnly === undefined
          ? false
          : z.enum(['true', 'false']).parse(query.unreadOnly) === 'true';
      response.json(
        await listInbox(
          { orgId, actor: { accountId: session.accountId } },
          {
            limit: page.limit,
            ...(query.cursor ? { cursor: z.string().parse(query.cursor) } : {}),
            unreadOnly,
          },
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.patch('/orgs/:orgId/inbox/:id/read', async (request, response) => {
    try {
      requireWriteOrigin(dependencies, request);
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const id = z.uuid().parse(request.params.id);
      const readAt = await markNotificationRead(
        { orgId, actor: { accountId: session.accountId } },
        id,
        dependencies.clock(),
      );
      response.json({ readAt: readAt.toISOString() });
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/orgs/:orgId/preferences', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      response.json(
        await listPreferences({
          orgId,
          actor: { accountId: session.accountId },
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.put(
    '/orgs/:orgId/preferences/:category/:channel',
    async (request, response) => {
      try {
        requireWriteOrigin(dependencies, request);
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const category = z
          .enum(['operational', 'announcement', 'marketing', 'emergency'])
          .parse(request.params.category);
        const channel = z
          .enum(['in_app', 'email'])
          .parse(request.params.channel);
        const input = updatePreferenceSchema.parse(request.body as unknown);
        response.json(
          await updatePreference(
            { orgId, actor: { accountId: session.accountId } },
            { category, channel, ...input },
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  return router;
}

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
      if (!response.headersSent) sendError(response, error);
    }
  });
  return router;
}
