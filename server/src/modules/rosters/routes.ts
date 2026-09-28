import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import {
  RostersService,
  RosterError,
  rosterCsv,
  rosterInputSchema,
  rosterUpdateSchema,
} from './service';

export function createRostersRouter(
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
            : error instanceof RosterError
              ? error.status
              : error instanceof Error &&
                  'status' in error &&
                  typeof error.status === 'number'
                ? error.status
                : 500;
        const code =
          error instanceof z.ZodError
            ? 'VALIDATION_ERROR'
            : error instanceof RosterError
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
        throw new RosterError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (
        request.get('X-Athlentry-Request') !== '1' ||
        request.get('Origin') !== new URL(dependencies.appUrl).origin
      )
        throw new RosterError(403, 'FORBIDDEN', 'Invalid write origin');
    }
    return new RostersService(dependencies.database, {
      orgId: z.uuid().parse(request.params.orgId),
      actor: { accountId: session.accountId },
    });
  };
  router.get(
    '/orgs/:orgId/team-seasons/:teamSeasonId/export.csv',
    async (request, response) => {
      try {
        const rows = await (
          await service(request)
        ).list(z.uuid().parse(request.params.teamSeasonId));
        response.setHeader('Content-Type', 'text/csv; charset=utf-8');
        response.setHeader(
          'Content-Disposition',
          'attachment; filename="roster.csv"',
        );
        response.send(rosterCsv(rows));
      } catch (error) {
        response.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message:
              error instanceof Error ? error.message : 'Roster unavailable',
          },
        });
      }
    },
  );
  router.get(
    '/orgs/:orgId/team-seasons/:teamSeasonId',
    run(async (request) =>
      (await service(request)).list(
        z.uuid().parse(request.params.teamSeasonId),
      ),
    ),
  );
  router.post(
    '/orgs/:orgId/team-seasons/:teamSeasonId',
    run(
      async (request) =>
        (await service(request, true)).add(
          z.uuid().parse(request.params.teamSeasonId),
          rosterInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.patch(
    '/orgs/:orgId/:entryId',
    run(async (request) =>
      (await service(request, true)).update(
        z.uuid().parse(request.params.entryId),
        rosterUpdateSchema.parse(request.body),
      ),
    ),
  );
  router.post(
    '/orgs/:orgId/:entryId/move',
    run(async (request) => {
      const body = z
        .object({
          destinationTeamSeasonId: z.uuid(),
          expectedVersion: z.number().int().positive(),
        })
        .parse(request.body);
      return (await service(request, true)).move(
        z.uuid().parse(request.params.entryId),
        body.destinationTeamSeasonId,
        body.expectedVersion,
      );
    }),
  );
  router.post(
    '/orgs/:orgId/:entryId/release',
    run(async (request) => {
      const body = z
        .object({ expectedVersion: z.number().int().positive() })
        .parse(request.body);
      return (await service(request, true)).release(
        z.uuid().parse(request.params.entryId),
        body.expectedVersion,
      );
    }),
  );
  return router;
}
