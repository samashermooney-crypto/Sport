import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import { LocalDiskStorage } from '../../integrations/storage/storage';
import type { ServerModule } from '../../lib/module-contract';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { importsJobs } from './jobs';
import { createImportsRouter } from './routes';
import { ImportsError, createImportsService } from './service';

function createMountedImportsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const scoped = createWithOrg(dependencies.database);
  const service = createImportsService(
    dependencies.database,
    dependencies.encryption,
    new LocalDiskStorage('data/uploads'),
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
    createImportsRouter({
      service,
      connectionString:
        process.env.DATABASE_URL ??
        'postgres://athlentry_app@127.0.0.1:5432/athlentry_dev',
      context: async (request) => {
        let accountId: string;
        try {
          accountId = (await requireSession(dependencies, request)).accountId;
        } catch {
          throw new ImportsError(401, 'UNAUTHORIZED', 'Sign in required');
        }
        const parsed = z.uuid().safeParse(request.get('X-Athlentry-Org'));
        if (!parsed.success)
          throw new ImportsError(404, 'NOT_FOUND', 'Organization not found');
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
          throw new ImportsError(404, 'NOT_FOUND', 'Organization not found');
        return context;
      },
    }),
  );
  return router;
}

export const moduleDefinition = {
  name: 'imports',
  path: '/api/v1/imports',
  router: createMountedImportsRouter,
  jobs: importsJobs,
  permissions: [],
  errorCodes: [],
} satisfies ServerModule;

export { createImportsRouter };
