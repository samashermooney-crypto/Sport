import { onboardingChecklistSchema } from '@shared/schemas/growth';
import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { ServerModule } from '../../lib/module-contract';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { createOnboardingRouter } from './routes';
import { OnboardingError, createOnboardingService } from './service';

const openapiRoutes = [
  {
    method: 'get',
    path: '/api/v1/onboarding/checklist',
    summary: 'Read the organization onboarding checklist',
    response: onboardingChecklistSchema,
  },
  {
    method: 'post',
    path: '/api/v1/onboarding/checklist/{key}/dismiss',
    summary: 'Dismiss an onboarding checklist item',
    response: z.null(),
    status: 204,
  },
  {
    method: 'post',
    path: '/api/v1/onboarding/checklist/{key}/restore',
    summary: 'Restore a dismissed onboarding checklist item',
    response: z.null(),
    status: 204,
  },
  {
    method: 'post',
    path: '/api/v1/onboarding/checklist/dismiss-all',
    summary: 'Dismiss all onboarding checklist items',
    response: z.null(),
    status: 204,
  },
];

function createMountedOnboardingRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const scoped = createWithOrg(dependencies.database);
  const service = createOnboardingService(dependencies.database);
  router.use((request, response, next) => {
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      request.method,
    );
    const bearer =
      /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
      !request.headers.cookie;
    if (
      mutating &&
      (request.get('X-Athlentry-Request') !== '1' ||
        (request.get('Origin') !== new URL(dependencies.appUrl).origin &&
          !(bearer && !request.get('Origin'))))
    ) {
      response.status(403).json({
        error: 'FORBIDDEN',
        message: 'Request origin could not be verified',
      });
      return;
    }
    next();
  });
  router.use(
    createOnboardingRouter({
      service,
      context: async (request) => {
        let accountId: string;
        try {
          accountId = (await requireSession(dependencies, request)).accountId;
        } catch {
          throw new OnboardingError(401, 'UNAUTHORIZED', 'Sign in required');
        }
        const parsed = z.uuid().safeParse(request.get('X-Athlentry-Org'));
        if (!parsed.success)
          throw new OnboardingError(404, 'NOT_FOUND', 'Organization not found');
        const context = { orgId: parsed.data, actor: { accountId } };
        const member = await scoped(context, (trx) =>
          trx
            .selectFrom('org_memberships')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('account_id', '=', accountId)
            .where('status', '=', 'active')
            .executeTakeFirst(),
        );
        if (!member)
          throw new OnboardingError(404, 'NOT_FOUND', 'Organization not found');
        return context;
      },
    }),
  );
  return router;
}

export const moduleDefinition = {
  name: 'onboarding',
  path: '/api/v1/onboarding',
  router: createMountedOnboardingRouter,
  jobs: [],
  permissions: [],
  errorCodes: [],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
