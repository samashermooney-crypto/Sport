import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import { programCatalog } from './catalog';
import { divisionGeneratorSchema } from './division-generator';
import {
  ProgramsService,
  ProgramError,
  programInputSchema,
  programUpdateSchema,
  divisionInputSchema,
} from './service';

export function createProgramsRouter(
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
            : error instanceof ProgramError
              ? error.status
              : error instanceof Error &&
                  'status' in error &&
                  typeof error.status === 'number'
                ? error.status
                : 500;
        const code =
          error instanceof z.ZodError
            ? 'VALIDATION_ERROR'
            : error instanceof ProgramError
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
        throw new ProgramError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (
        request.get('X-Athlentry-Request') !== '1' ||
        request.get('Origin') !== new URL(dependencies.appUrl).origin
      )
        throw new ProgramError(403, 'FORBIDDEN', 'Invalid write origin');
    }
    return new ProgramsService(dependencies.database, {
      orgId: z.uuid().parse(request.params.orgId),
      actor: { accountId: session.accountId },
    });
  };
  router.get(
    '/orgs/:orgId',
    run(async (request) =>
      (await service(request)).list(
        request.query.seasonId
          ? z.uuid().parse(request.query.seasonId)
          : undefined,
      ),
    ),
  );
  router.get(
    '/catalog/:orgSlug',
    run(async (request) =>
      programCatalog(
        dependencies.database,
        z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .parse(request.params.orgSlug),
      ),
    ),
  );
  router.get(
    '/catalog/:orgSlug/:programSlug',
    run(async (request) =>
      programCatalog(
        dependencies.database,
        z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .parse(request.params.orgSlug),
        z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .parse(request.params.programSlug),
      ),
    ),
  );
  router.post(
    '/orgs/:orgId',
    run(
      async (request) =>
        (await service(request, true)).create(
          programInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.get(
    '/orgs/:orgId/:programId',
    run(async (request) =>
      (await service(request)).get(z.uuid().parse(request.params.programId)),
    ),
  );
  router.patch(
    '/orgs/:orgId/:programId',
    run(async (request) =>
      (await service(request, true)).update(
        z.uuid().parse(request.params.programId),
        programUpdateSchema.parse(request.body),
      ),
    ),
  );
  router.post(
    '/orgs/:orgId/:programId/status',
    run(async (request) => {
      const body = z
        .object({
          status: z.enum([
            'draft',
            'published',
            'registration_open',
            'registration_closed',
            'in_progress',
            'completed',
            'archived',
          ]),
          expectedVersion: z.number().int().positive(),
        })
        .parse(request.body);
      return (await service(request, true)).setStatus(
        z.uuid().parse(request.params.programId),
        body.status,
        body.expectedVersion,
      );
    }),
  );
  router.post(
    '/orgs/:orgId/:programId/divisions',
    run(
      async (request) =>
        (await service(request, true)).addDivision(
          z.uuid().parse(request.params.programId),
          divisionInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.post(
    '/orgs/:orgId/:programId/divisions/generate',
    run(
      async (request) =>
        (await service(request, true)).generate(
          z.uuid().parse(request.params.programId),
          divisionGeneratorSchema.parse(request.body),
        ),
      201,
    ),
  );
  return router;
}
