import { apiErrorSchema } from '@shared/schemas/errors';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

import { parsePageRequest } from '../../lib/pagination';
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

function orgIdFrom(request: Request): string {
  return z.uuid().parse(request.params.orgId ?? request.query.orgId);
}

export function createNotificationHandlers(dependencies: AuthDependencies): {
  inbox: RequestHandler;
  markRead: RequestHandler;
  preferences: RequestHandler;
  updatePreference: RequestHandler;
} {
  return {
    inbox: async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        const orgId = orgIdFrom(request);
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
              ...(query.cursor
                ? { cursor: z.string().parse(query.cursor) }
                : {}),
              unreadOnly,
            },
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
    markRead: async (request, response) => {
      try {
        requireWriteOrigin(dependencies, request);
        const session = await requireSession(dependencies, request);
        const orgId = orgIdFrom(request);
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
    },
    preferences: async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        const orgId = orgIdFrom(request);
        response.json(
          await listPreferences({
            orgId,
            actor: { accountId: session.accountId },
          }),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
    updatePreference: async (request, response) => {
      try {
        requireWriteOrigin(dependencies, request);
        const session = await requireSession(dependencies, request);
        const orgId = orgIdFrom(request);
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
  };
}
