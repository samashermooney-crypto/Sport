import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import { SportsError, SportsService, sportTemplates } from './service';

const updateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  profile: z.unknown(),
});

export function createSportsRouter(
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
        const code =
          error instanceof z.ZodError
            ? 'VALIDATION_ERROR'
            : error instanceof SportsError
              ? error.code
              : 'INTERNAL_ERROR';
        const statusCode =
          error instanceof z.ZodError
            ? 400
            : error instanceof SportsError
              ? error.status
              : error instanceof Error &&
                  'status' in error &&
                  typeof error.status === 'number'
                ? error.status
                : 500;
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
        throw new SportsError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (
        request.get('X-Athlentry-Request') !== '1' ||
        request.get('Origin') !== new URL(dependencies.appUrl).origin
      )
        throw new SportsError(403, 'FORBIDDEN', 'Invalid write origin');
    }
    return new SportsService(dependencies.database, {
      orgId: z.uuid().parse(request.params.orgId),
      actor: { accountId: session.accountId },
    });
  };
  router.get(
    '/templates',
    run(async (request) => {
      await requireSession(dependencies, request);
      return sportTemplates();
    }),
  );
  router.get(
    '/orgs/:orgId',
    run(async (request) => (await service(request)).list()),
  );
  router.post(
    '/orgs/:orgId',
    run(
      async (request) =>
        (await service(request, true)).clone(
          z.object({ templateKey: z.string() }).parse(request.body).templateKey,
        ),
      201,
    ),
  );
  router.patch(
    '/orgs/:orgId/:profileId',
    run(async (request) => {
      const body = updateSchema.parse(request.body);
      return (await service(request, true)).update(
        z.uuid().parse(request.params.profileId),
        body.expectedVersion,
        body.profile as Parameters<SportsService['update']>[2],
      );
    }),
  );
  router.get(
    '/orgs/:orgId/:profileId/versions',
    run(async (request) =>
      (await service(request)).history(
        z.uuid().parse(request.params.profileId),
      ),
    ),
  );
  return router;
}
