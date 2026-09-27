import { apiErrorSchema } from '@shared/schemas/errors';
import express from 'express';
import { z } from 'zod';

import { parsePageRequest } from '../../lib/pagination';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { AuditAccessError, listAuditEntries } from './service';

export function createAuditRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.get('/orgs/:orgId', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const query = request.query as Record<string, unknown>;
      const page = parsePageRequest(query, ['created_at'], 'created_at');
      const entityType =
        query.entityType === undefined
          ? undefined
          : z.string().min(1).max(100).parse(query.entityType);
      const entityId =
        query.entityId === undefined
          ? undefined
          : z.uuid().parse(query.entityId);
      const restrictedOnly = query.restrictedOnly === 'true';
      const result = await listAuditEntries(
        { orgId, actor: { accountId: session.accountId } },
        {
          limit: page.limit,
          ...(page.cursor ? { cursor: z.string().parse(query.cursor) } : {}),
          ...(entityType ? { entityType } : {}),
          ...(entityId ? { entityId } : {}),
          restrictedOnly,
        },
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(result);
    } catch (error) {
      const status =
        error instanceof AuditAccessError
          ? 404
          : error instanceof z.ZodError || error instanceof RangeError
            ? 400
            : error instanceof Error &&
                'status' in error &&
                error.status === 401
              ? 401
              : 500;
      const code =
        status === 404
          ? 'NOT_FOUND'
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
          },
        }),
      );
    }
  });
  return router;
}
