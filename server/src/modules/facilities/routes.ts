import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import {
  FacilitiesService,
  FacilityError,
  availabilityInputSchema,
  blackoutInputSchema,
  facilityInputSchema,
  spaceInputSchema,
  spaceUpdateSchema,
} from './service';

export function createFacilitiesRouter(
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
            : error instanceof FacilityError
              ? error.status
              : error instanceof Error &&
                  'status' in error &&
                  typeof error.status === 'number'
                ? error.status
                : 500;
        const code =
          error instanceof z.ZodError
            ? 'VALIDATION_ERROR'
            : error instanceof FacilityError
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
        throw new FacilityError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (
        request.get('X-Athlentry-Request') !== '1' ||
        request.get('Origin') !== new URL(dependencies.appUrl).origin
      )
        throw new FacilityError(403, 'FORBIDDEN', 'Invalid write origin');
    }
    return new FacilitiesService(dependencies.database, {
      orgId: z.uuid().parse(request.params.orgId),
      actor: { accountId: session.accountId },
    });
  };
  router.get(
    '/orgs/:orgId',
    run(async (request) => (await service(request)).list()),
  );
  router.post(
    '/orgs/:orgId',
    run(
      async (request) =>
        (await service(request, true)).createFacility(
          facilityInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.patch(
    '/orgs/:orgId/:facilityId',
    run(async (request) => {
      const body = z
        .object({
          expectedVersion: z.number().int().positive(),
          facility: facilityInputSchema,
        })
        .parse(request.body);
      return (await service(request, true)).updateFacility(
        z.uuid().parse(request.params.facilityId),
        body.expectedVersion,
        body.facility,
      );
    }),
  );
  router.post(
    '/orgs/:orgId/spaces',
    run(
      async (request) =>
        (await service(request, true)).createSpace(
          spaceInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.patch(
    '/orgs/:orgId/spaces/:spaceId',
    run(async (request) =>
      (await service(request, true)).updateSpace(
        z.uuid().parse(request.params.spaceId),
        spaceUpdateSchema.parse(request.body),
      ),
    ),
  );
  router.post(
    '/orgs/:orgId/spaces/:spaceId/archive',
    run(async (request) => {
      const body = z
        .object({ expectedVersion: z.number().int().positive() })
        .parse(request.body);
      return (await service(request, true)).archiveSpace(
        z.uuid().parse(request.params.spaceId),
        body.expectedVersion,
      );
    }),
  );
  router.post(
    '/orgs/:orgId/:facilityId/archive',
    run(async (request) => {
      const body = z
        .object({ expectedVersion: z.number().int().positive() })
        .parse(request.body);
      return (await service(request, true)).archiveFacility(
        z.uuid().parse(request.params.facilityId),
        body.expectedVersion,
      );
    }),
  );
  router.get(
    '/orgs/:orgId/spaces/:spaceId/availability',
    run(async (request) =>
      (await service(request)).availability(
        z.uuid().parse(request.params.spaceId),
      ),
    ),
  );
  router.post(
    '/orgs/:orgId/availability',
    run(
      async (request) =>
        (await service(request, true)).addAvailability(
          availabilityInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.delete(
    '/orgs/:orgId/availability/:availabilityId',
    run(async (request) => {
      const body = z
        .object({ expectedVersion: z.number().int().positive() })
        .parse(request.body);
      return (await service(request, true)).deleteAvailability(
        z.uuid().parse(request.params.availabilityId),
        body.expectedVersion,
      );
    }),
  );
  router.get(
    '/orgs/:orgId/blackouts',
    run(async (request) => (await service(request)).blackouts()),
  );
  router.post(
    '/orgs/:orgId/blackouts',
    run(
      async (request) =>
        (await service(request, true)).addBlackout(
          blackoutInputSchema.parse(request.body),
        ),
      201,
    ),
  );
  router.delete(
    '/orgs/:orgId/blackouts/:blackoutId',
    run(async (request) =>
      (await service(request, true)).deleteBlackout(
        z.uuid().parse(request.params.blackoutId),
      ),
    ),
  );
  return router;
}
