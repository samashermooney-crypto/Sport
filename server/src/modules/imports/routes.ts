import {
  importBatchCreateSchema,
  importMappingPresetSaveSchema,
  importKindSchema,
} from '@shared/schemas/imports';
import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';
import { PeopleError } from '../people/repo';

import { createImportsRepository } from './repo';

function validWriteOrigin(request: express.Request, appUrl: string): boolean {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearer && request.get('Origin') === undefined))
  );
}

function sendError(response: express.Response, error: unknown): void {
  const status =
    error instanceof z.ZodError
      ? 400
      : error instanceof PeopleError
        ? error.status
        : error instanceof Error &&
            'status' in error &&
            typeof error.status === 'number'
          ? error.status
          : 500;
  response.status(status).json({
    error: {
      code:
        error instanceof z.ZodError
          ? 'VALIDATION_ERROR'
          : error instanceof PeopleError
            ? error.code
            : status === 401
              ? 'UNAUTHENTICATED'
              : 'INTERNAL_ERROR',
      message:
        status === 500
          ? 'The request could not be completed'
          : error instanceof Error
            ? error.message
            : 'Request failed',
      ...(error instanceof PeopleError && error.details !== undefined
        ? { details: error.details }
        : {}),
    },
  });
}

export function createImportsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const imports = createImportsRepository(dependencies.database);
  router.use(express.json({ limit: '10mb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/orgs/:orgId/batches', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      response.json(
        await imports.list(
          z.uuid().parse(request.params.orgId),
          session.accountId,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/batches', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      const input = importBatchCreateSchema.parse(request.body);
      response
        .status(201)
        .json(
          await imports.create(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            input,
          ),
        );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/batches/:batchId', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      response.json(
        await imports.get(
          z.uuid().parse(request.params.orgId),
          session.accountId,
          z.uuid().parse(request.params.batchId),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/batches/:batchId/commit', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      response.json(
        await imports.commit(
          z.uuid().parse(request.params.orgId),
          session.accountId,
          z.uuid().parse(request.params.batchId),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post(
    '/orgs/:orgId/batches/:batchId/rollback',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        response.json(
          await imports.rollback(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.batchId),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get('/orgs/:orgId/presets', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      const kind = request.query.kind
        ? importKindSchema.parse(request.query.kind)
        : undefined;
      response.json(
        await imports.listPresets(
          z.uuid().parse(request.params.orgId),
          session.accountId,
          kind,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/presets', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      const input = importMappingPresetSaveSchema.parse(request.body);
      response
        .status(201)
        .json(
          await imports.savePreset(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            input,
          ),
        );
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
