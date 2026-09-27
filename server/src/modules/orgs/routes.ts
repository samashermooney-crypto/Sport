import { apiErrorSchema } from '@shared/schemas/errors';
import {
  createOrgResponseSchema,
  createOrgSchema,
  orgSlugAvailabilitySchema,
  orgSlugSchema,
} from '@shared/schemas/orgs';
import express from 'express';
import { z } from 'zod';

import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { createOrganization, OrgCreationError } from './create';
import { isOrgSlugAvailable } from './slug';

export function createOrgRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/slug-availability', async (request, response) => {
    try {
      await requireSession(dependencies, request);
      const slug = orgSlugSchema.parse(request.query.slug);
      const available = await isOrgSlugAvailable(dependencies.database, slug);
      response.json(orgSlugAvailabilitySchema.parse({ slug, available }));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/', async (request, response) => {
    try {
      const origin = new URL(dependencies.appUrl).origin;
      const bearerRequest =
        /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
        !request.headers.cookie;
      if (
        request.get('X-Athlentry-Request') !== '1' ||
        (request.get('Origin') !== origin &&
          !(bearerRequest && request.get('Origin') === undefined))
      ) {
        response.status(403).json(
          apiErrorSchema.parse({
            error: {
              code: 'FORBIDDEN',
              message: 'Request origin could not be verified',
            },
          }),
        );
        return;
      }
      const session = await requireSession(dependencies, request);
      const input = createOrgSchema.parse(request.body as unknown);
      const result = await createOrganization(
        dependencies.database,
        session.accountId,
        input,
        dependencies.clock(),
      );
      response.status(201).json(createOrgResponseSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });
  return router;
}

function sendError(response: express.Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    response.status(400).json(
      apiErrorSchema.parse({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Check the organization details',
        },
      }),
    );
  } else if (error instanceof OrgCreationError) {
    const status =
      error.code === 'CONFLICT' ? 409 : error.code === 'FORBIDDEN' ? 403 : 400;
    response.status(status).json(
      apiErrorSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  } else if (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    'code' in error &&
    error.code === 'UNAUTHENTICATED'
  ) {
    response.status(401).json(
      apiErrorSchema.parse({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' },
      }),
    );
  } else {
    response.status(500).json(
      apiErrorSchema.parse({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The request could not be completed',
        },
      }),
    );
  }
}
