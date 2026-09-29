import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { ServerModule } from '../../lib/module-contract';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { helpOpenApiRoutes } from './openapi';
import { createHelpRouter } from './routes';
import { HelpError, createHelpService } from './service';

function createMountedHelpRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const scoped = createWithOrg(dependencies.database);
  const service = createHelpService(
    dependencies.database,
    dependencies.email,
    process.env['SUPPORT_INBOX'] ?? null,
  );
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
    createHelpRouter({
      service,
      context: async (request) => {
        let accountId: string;
        try {
          accountId = (await requireSession(dependencies, request)).accountId;
        } catch {
          throw new HelpError(401, 'UNAUTHORIZED', 'Sign in required');
        }
        const parsed = z.uuid().safeParse(request.get('X-Athlentry-Org'));
        if (!parsed.success)
          throw new HelpError(404, 'NOT_FOUND', 'Organization not found');
        const context = { orgId: parsed.data, actor: { accountId } };
        const access = await scoped(context, async (trx) => {
          const member = await trx
            .selectFrom('org_memberships')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('account_id', '=', accountId)
            .where('status', '=', 'active')
            .executeTakeFirst();
          if (member) return 'staff';
          const family = await trx
            .selectFrom('person_account_links')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('account_id', '=', accountId)
            .where('verified_at', 'is not', null)
            .where('revoked_at', 'is', null)
            .executeTakeFirst();
          return family ? 'family' : null;
        });
        if (!access)
          throw new HelpError(404, 'NOT_FOUND', 'Organization not found');
        return context;
      },
    }),
  );
  return router;
}

export const moduleDefinition = {
  name: 'help',
  path: '/api/v1/help',
  router: createMountedHelpRouter,
  jobs: [],
  permissions: [],
  errorCodes: [],
  openapiRoutes: helpOpenApiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
