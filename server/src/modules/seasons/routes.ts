import express from 'express';
import { z } from 'zod';

import { idempotentRoute } from '../../lib/idempotency';
import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import {
  SeasonsService,
  SeasonError,
  rolloverSchema,
  seasonCreateSchema,
  seasonUpdateSchema,
} from './service';

export function createSeasonsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
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
            : error instanceof SeasonError
              ? error.status
              : error instanceof Error &&
                  'status' in error &&
                  typeof error.status === 'number'
                ? error.status
                : 500;
        const code =
          error instanceof z.ZodError
            ? 'VALIDATION_ERROR'
            : error instanceof SeasonError
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
  const context = async (request: express.Request, writing = false) => {
    const session = await requireSession(dependencies, request);
    if (writing) {
      if (requestImpersonation(request))
        throw new SeasonError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (
        request.get('X-Athlentry-Request') !== '1' ||
        request.get('Origin') !== new URL(dependencies.appUrl).origin
      )
        throw new SeasonError(403, 'FORBIDDEN', 'Invalid write origin');
    }
    return {
      orgId: z.uuid().parse(request.params.orgId),
      actor: { accountId: session.accountId },
    };
  };
  router.get(
    '/orgs/:orgId',
    run(async (request) =>
      new SeasonsService(dependencies.database, await context(request)).list(),
    ),
  );
  router.post(
    '/orgs/:orgId',
    run(
      async (request) =>
        new SeasonsService(
          dependencies.database,
          await context(request, true),
        ).create(seasonCreateSchema.parse(request.body)),
      201,
    ),
  );
  router.patch(
    '/orgs/:orgId/:seasonId',
    run(async (request) =>
      new SeasonsService(
        dependencies.database,
        await context(request, true),
      ).update(
        z.uuid().parse(request.params.seasonId),
        seasonUpdateSchema.parse(request.body),
      ),
    ),
  );
  router.post(
    '/orgs/:orgId/:seasonId/rollover/preview',
    run(async (request) =>
      new SeasonsService(
        dependencies.database,
        await context(request, true),
      ).preview(
        z.uuid().parse(request.params.seasonId),
        rolloverSchema.parse(request.body),
      ),
    ),
  );
  router.post(
    '/orgs/:orgId/:seasonId/rollover',
    idempotentRoute({
      context: (request) => context(request, true),
      runWithOrg: (ctx, callback) =>
        import('../../db/withOrg').then(({ createWithOrg }) =>
          createWithOrg(dependencies.database)(ctx, callback),
        ),
      execute: async (request, trx) => {
        const ctx = await context(request, true);
        const result = await new SeasonsService(
          dependencies.database,
          ctx,
        ).rolloverInTransaction(
          trx,
          z.uuid().parse(request.params.seasonId),
          rolloverSchema.parse(request.body),
        );
        return {
          status: 201,
          body: JSON.parse(JSON.stringify(result)) as unknown,
        };
      },
    }),
  );
  return router;
}
