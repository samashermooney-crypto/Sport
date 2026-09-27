import { apiErrorSchema } from '@shared/schemas/errors';
import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { parsePageRequest } from '../../lib/pagination';
import { VersionConflictError } from '../../lib/version-check';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import {
  featureFlagInputSchema,
  getPlatformAdminDatabase,
  listFeatureFlags,
  listPlans,
  listPlatformStaff,
  planInputSchema,
  saveFeatureFlag,
  savePlan,
  savePlatformStaff,
} from './admin';
import { platformHealth } from './health';
import {
  endImpersonation,
  getImpersonation,
  startImpersonation,
} from './impersonation';
import {
  featureFlagResultSchema,
  featureFlagsSchema,
  healthSchema,
  impersonationInputSchema,
  impersonationSchema,
  okSchema,
  orgDetailSchema,
  orgPageSchema,
  platformMeSchema,
  planAssignmentResultSchema,
  planAssignmentSchema,
  plansSchema,
  saveResultSchema,
  staffInputSchema,
  staffListSchema,
  staffResultSchema,
  statusInputSchema,
  statusResultSchema,
} from './schema';
import {
  getOrganization,
  listOrganizations,
  PlatformAccessError,
  requirePlatformStaff,
  setOrganizationPlan,
  setOrganizationStatus,
} from './service';
import type { PlatformRole } from './service';

function sendError(response: Response, error: unknown): void {
  const status =
    error instanceof PlatformAccessError
      ? error.status
      : error instanceof VersionConflictError
        ? 409
        : error instanceof z.ZodError || error instanceof RangeError
          ? 400
          : error instanceof Error && 'status' in error && error.status === 401
            ? 401
            : 500;
  const code =
    status === 404
      ? 'NOT_FOUND'
      : status === 403
        ? 'FORBIDDEN'
        : status === 409
          ? 'CONFLICT'
          : status === 400
            ? 'VALIDATION_ERROR'
            : status === 401
              ? 'UNAUTHENTICATED'
              : 'INTERNAL_ERROR';
  response.status(status).json(
    apiErrorSchema.parse({
      error: {
        code,
        message:
          status === 500
            ? 'The request could not be completed'
            : error instanceof Error
              ? error.message
              : 'Request failed',
        ...(error instanceof VersionConflictError
          ? {
              fields: {
                currentVersion: String(
                  (error.current as { version: number }).version,
                ),
              },
            }
          : {}),
      },
    }),
  );
}

function requireWriteOrigin(
  dependencies: AuthDependencies,
  request: Request,
): void {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  if (
    request.get('X-Athlentry-Request') !== '1' ||
    (request.get('Origin') !== new URL(dependencies.appUrl).origin &&
      !(bearer && !request.get('Origin')))
  )
    throw new PlatformAccessError('Request origin could not be verified');
}

export function createPlatformRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  const staff = async (request: Request, roles: readonly PlatformRole[]) =>
    requirePlatformStaff(
      dependencies.database,
      await requireSession(dependencies, request),
      roles,
    );
  const all = ['super_admin', 'support', 'finance_ops'] as const;
  const admin = ['super_admin'] as const;

  router.get('/me', async (request, response) => {
    try {
      response.json(platformMeSchema.parse(await staff(request, all)));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs', async (request, response) => {
    try {
      await staff(request, all);
      const query = request.query as Record<string, unknown>;
      const page = parsePageRequest(query, ['created_at'], 'created_at');
      const search =
        query.search === undefined
          ? undefined
          : z.string().trim().min(1).max(100).parse(query.search);
      response.json(
        orgPageSchema.parse(
          await listOrganizations(dependencies.database, {
            limit: page.limit,
            ...(query.cursor ? { cursor: z.string().parse(query.cursor) } : {}),
            ...(search ? { search } : {}),
          }),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/orgs/:orgId', async (request, response) => {
    try {
      const actor = await staff(request, all);
      response.json(
        orgDetailSchema.parse(
          await getOrganization(
            dependencies.database,
            actor,
            z.uuid().parse(request.params.orgId),
          ),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.patch('/orgs/:orgId/status', async (request, response) => {
    try {
      requireWriteOrigin(dependencies, request);
      const actor = await staff(request, admin);
      const input = statusInputSchema.parse(request.body as unknown);
      response.json(
        statusResultSchema.parse(
          await setOrganizationStatus(
            dependencies.database,
            actor,
            z.uuid().parse(request.params.orgId),
            input,
          ),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.patch('/orgs/:orgId/plan', async (request, response) => {
    try {
      requireWriteOrigin(dependencies, request);
      const actor = await staff(request, admin);
      const input = planAssignmentSchema.parse(request.body as unknown);
      response.json(
        planAssignmentResultSchema.parse(
          await setOrganizationPlan(
            dependencies.database,
            actor,
            z.uuid().parse(request.params.orgId),
            input,
          ),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/plans', async (request, response) => {
    try {
      await staff(request, all);
      response.json(
        plansSchema.parse({ items: await listPlans(dependencies.database) }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/plans', async (request, response) => {
    try {
      requireWriteOrigin(dependencies, request);
      const actor = await staff(request, admin);
      response
        .status(201)
        .json(
          saveResultSchema.parse(
            await savePlan(
              getPlatformAdminDatabase(),
              actor,
              null,
              planInputSchema.parse(request.body as unknown),
            ),
          ),
        );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.put('/plans/:id', async (request, response) => {
    try {
      requireWriteOrigin(dependencies, request);
      const actor = await staff(request, admin);
      response.json(
        saveResultSchema.parse(
          await savePlan(
            getPlatformAdminDatabase(),
            actor,
            z.uuid().parse(request.params.id),
            planInputSchema.parse(request.body as unknown),
          ),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/feature-flags', async (request, response) => {
    try {
      await staff(request, all);
      response.json(
        featureFlagsSchema.parse({
          items: await listFeatureFlags(dependencies.database),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.put('/feature-flags/:key', async (request, response) => {
    try {
      requireWriteOrigin(dependencies, request);
      const actor = await staff(request, admin);
      response.json(
        featureFlagResultSchema.parse(
          await saveFeatureFlag(
            getPlatformAdminDatabase(),
            actor,
            z.string().parse(request.params.key),
            featureFlagInputSchema.parse(request.body as unknown),
          ),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/staff', async (request, response) => {
    try {
      await staff(request, all);
      response.json(
        staffListSchema.parse({
          items: await listPlatformStaff(dependencies.database),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.put('/staff/:accountId', async (request, response) => {
    try {
      requireWriteOrigin(dependencies, request);
      const actor = await staff(request, admin);
      response.json(
        staffResultSchema.parse(
          await savePlatformStaff(
            getPlatformAdminDatabase(),
            actor,
            z.uuid().parse(request.params.accountId),
            staffInputSchema.parse(request.body as unknown),
          ),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/impersonations', async (request, response) => {
    try {
      requireWriteOrigin(dependencies, request);
      const actor = await staff(request, ['super_admin', 'support']);
      const input = impersonationInputSchema.parse(request.body as unknown);
      response
        .status(201)
        .json(
          impersonationSchema.parse(
            await startImpersonation(
              getPlatformAdminDatabase(),
              actor,
              input.organizationId,
              input.reason,
              dependencies.clock(),
            ),
          ),
        );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/impersonations/:id', async (request, response) => {
    try {
      const actor = await staff(request, ['super_admin', 'support']);
      response.json(
        impersonationSchema.parse(
          await getImpersonation(
            dependencies.database,
            actor,
            z.uuid().parse(request.params.id),
            dependencies.clock(),
          ),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.delete('/impersonations/:id', async (request, response) => {
    try {
      requireWriteOrigin(dependencies, request);
      const actor = await staff(request, ['super_admin', 'support']);
      await endImpersonation(
        getPlatformAdminDatabase(),
        actor,
        z.uuid().parse(request.params.id),
        dependencies.clock(),
      );
      response.json(okSchema.parse({ ok: true }));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/health', async (request, response) => {
    try {
      await staff(request, all);
      response.json(
        healthSchema.parse(await platformHealth(dependencies.database)),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  return router;
}
