import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import {
  OfferingsService,
  OfferingError,
  offeringInputSchema,
  offeringUpdateSchema,
} from './service';

export function createOfferingsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '128kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  const run =
    (handler: (request: express.Request) => Promise<unknown>, status = 200) =>
    async (request: express.Request, response: express.Response) => {
      try {
        response.status(status).json(await handler(request));
      } catch (error) {
        const statusCode =
          error instanceof z.ZodError
            ? 400
            : error instanceof OfferingError
              ? error.status
              : error instanceof Error &&
                  'status' in error &&
                  typeof error.status === 'number'
                ? error.status
                : 500;
        const code =
          error instanceof z.ZodError
            ? 'VALIDATION_ERROR'
            : error instanceof OfferingError
              ? error.code
              : statusCode === 404
                ? 'NOT_FOUND'
                : 'INTERNAL_ERROR';
        response.status(statusCode).json({
          error: {
            code,
            message:
              statusCode === 500
                ? 'The request could not be completed'
                : error instanceof Error
                  ? error.message
                  : 'Request failed',
          },
        });
      }
    };
  const service = async (request: express.Request, writing = false) => {
    const session = await requireSession(dependencies, request);
    if (writing) {
      if (requestImpersonation(request))
        throw new OfferingError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (
        request.get('X-Athlentry-Request') !== '1' ||
        request.get('Origin') !== new URL(dependencies.appUrl).origin
      )
        throw new OfferingError(403, 'FORBIDDEN', 'Invalid write origin');
    }
    return new OfferingsService(dependencies.database, {
      orgId: z.uuid().parse(request.params.orgId),
      actor: { accountId: session.accountId },
    });
  };
  router.get(
    '/orgs/:orgId/programs/:programId',
    run(async (request) =>
      (await service(request)).list(z.uuid().parse(request.params.programId)),
    ),
  );
  router.post(
    '/orgs/:orgId',
    run(
      async (request) =>
        (await service(request, true)).create(
          offeringInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.patch(
    '/orgs/:orgId/:offeringId',
    run(async (request) =>
      (await service(request, true)).update(
        z.uuid().parse(request.params.offeringId),
        offeringUpdateSchema.parse(request.body),
      ),
    ),
  );
  router.get(
    '/orgs/:orgId/installment-templates',
    run(async (request) => ({
      templates: await (await service(request)).templates(),
    })),
  );
  router.get(
    '/orgs/:orgId/pricing-context',
    run(async (request) => (await service(request)).pricingContext()),
  );
  router.get(
    '/orgs/:orgId/libraries',
    run(async (request) => (await service(request)).libraries()),
  );
  return router;
}
