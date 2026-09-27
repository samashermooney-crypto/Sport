import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import {
  TeamsService,
  TeamError,
  staffInputSchema,
  teamForProgramInputSchema,
  teamGeneratorSchema,
  teamInputSchema,
  teamSeasonInputSchema,
  teamSeasonUpdateSchema,
  teamUpdateSchema,
} from './service';

export function createTeamsRouter(
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
            : error instanceof TeamError
              ? error.status
              : error instanceof Error &&
                  'status' in error &&
                  typeof error.status === 'number'
                ? error.status
                : 500;
        const code =
          error instanceof z.ZodError
            ? 'VALIDATION_ERROR'
            : error instanceof TeamError
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
        throw new TeamError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (
        request.get('X-Athlentry-Request') !== '1' ||
        request.get('Origin') !== new URL(dependencies.appUrl).origin
      )
        throw new TeamError(403, 'FORBIDDEN', 'Invalid write origin');
    }
    return new TeamsService(dependencies.database, {
      orgId: z.uuid().parse(request.params.orgId),
      actor: { accountId: session.accountId },
    });
  };
  router.get(
    '/orgs/:orgId',
    run(async (request) =>
      (await service(request)).list(
        request.query.programId
          ? z.uuid().parse(request.query.programId)
          : undefined,
      ),
    ),
  );
  router.post(
    '/orgs/:orgId',
    run(
      async (request) =>
        (await service(request, true)).createTeam(
          teamInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.post(
    '/orgs/:orgId/seasons/manual',
    run(
      async (request) =>
        (await service(request, true)).createForProgram(
          teamForProgramInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.post(
    '/orgs/:orgId/seasons',
    run(
      async (request) =>
        (await service(request, true)).joinProgram(
          teamSeasonInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.patch(
    '/orgs/:orgId/:teamId',
    run(async (request) =>
      (await service(request, true)).updateTeam(
        z.uuid().parse(request.params.teamId),
        teamUpdateSchema.parse(request.body),
      ),
    ),
  );
  router.patch(
    '/orgs/:orgId/seasons/:teamSeasonId',
    run(async (request) =>
      (await service(request, true)).updateTeamSeason(
        z.uuid().parse(request.params.teamSeasonId),
        teamSeasonUpdateSchema.parse(request.body),
      ),
    ),
  );
  router.get(
    '/orgs/:orgId/seasons/:teamSeasonId/staff',
    run(async (request) =>
      (await service(request)).listStaff(
        z.uuid().parse(request.params.teamSeasonId),
      ),
    ),
  );
  router.post(
    '/orgs/:orgId/generate',
    run(
      async (request) =>
        (await service(request, true)).generate(
          teamGeneratorSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.post(
    '/orgs/:orgId/seasons/:teamSeasonId/staff',
    run(
      async (request) =>
        (await service(request, true)).assignStaff(
          z.uuid().parse(request.params.teamSeasonId),
          staffInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.post(
    '/orgs/:orgId/staff/:staffId/revalidate',
    run(async (request) =>
      (await service(request, true)).revalidateStaff(
        z.uuid().parse(request.params.staffId),
      ),
    ),
  );
  router.post(
    '/orgs/:orgId/staff/:staffId/remove',
    run(async (request) => {
      const body = z
        .object({ expectedVersion: z.number().int().positive() })
        .parse(request.body);
      return (await service(request, true)).removeStaff(
        z.uuid().parse(request.params.staffId),
        body.expectedVersion,
      );
    }),
  );
  router.post(
    '/orgs/:orgId/seasons/:teamSeasonId/roster-lock',
    run(async (request) => {
      const body = z
        .object({
          expectedVersion: z.number().int().positive(),
          locked: z.boolean(),
        })
        .parse(request.body);
      return (await service(request, true)).setRosterLock(
        z.uuid().parse(request.params.teamSeasonId),
        body.expectedVersion,
        body.locked,
      );
    }),
  );
  return router;
}
