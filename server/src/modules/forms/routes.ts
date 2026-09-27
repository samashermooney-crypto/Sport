import {
  formDefinitionCreateSchema,
  formDefinitionUpdateSchema,
  formResponseSubmitSchema,
} from '@shared/schemas/forms';
import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import { createFormsService, FormsError } from './service';

const publishSchema = z.strictObject({ expectedVersion: z.int().positive() });
const uuidQuerySchema = z.strictObject({ personId: z.uuid() });

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
      : error instanceof FormsError
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
          : error instanceof FormsError
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
    },
  });
}

export function createFormsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const forms = createFormsService(
    dependencies.database,
    dependencies.encryption,
  );
  router.use(express.json({ limit: '128kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/orgs/:orgId', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new FormsError(404, 'NOT_FOUND', 'Form was not found');
      response.json(
        await forms.list({
          orgId: z.uuid().parse(request.params.orgId),
          actor: { accountId: session.accountId },
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId', async (request, response) => {
    try {
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new FormsError(403, 'FORBIDDEN', 'Invalid request origin');
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new FormsError(403, 'FORBIDDEN', 'Impersonation is read-only');
      response.status(201).json(
        await forms.create(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          formDefinitionCreateSchema.parse(request.body),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.patch('/orgs/:orgId/:formId', async (request, response) => {
    try {
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new FormsError(403, 'FORBIDDEN', 'Invalid request origin');
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new FormsError(403, 'FORBIDDEN', 'Impersonation is read-only');
      response.json(
        await forms.update(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          z.uuid().parse(request.params.formId),
          formDefinitionUpdateSchema.parse(request.body),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/:formId/publish', async (request, response) => {
    try {
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new FormsError(403, 'FORBIDDEN', 'Invalid request origin');
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new FormsError(403, 'FORBIDDEN', 'Impersonation is read-only');
      const input = publishSchema.parse(request.body);
      response.json(
        await forms.publish(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          z.uuid().parse(request.params.formId),
          input.expectedVersion,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/:formId/reuse', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new FormsError(404, 'NOT_FOUND', 'Form was not found');
      const query = uuidQuerySchema.parse(request.query);
      response.json(
        await forms.reusableAnswers(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          z.uuid().parse(request.params.formId),
          query.personId,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/responses', async (request, response) => {
    try {
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new FormsError(403, 'FORBIDDEN', 'Invalid request origin');
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new FormsError(403, 'FORBIDDEN', 'Impersonation is read-only');
      response.status(201).json(
        await forms.submit(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          formResponseSubmitSchema.parse(request.body),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get(
    '/orgs/:orgId/responses/:responseId',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new FormsError(404, 'NOT_FOUND', 'Form response was not found');
        response.json(
          await forms.renderResponse(
            {
              orgId: z.uuid().parse(request.params.orgId),
              actor: { accountId: session.accountId },
            },
            z.uuid().parse(request.params.responseId),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  return router;
}
