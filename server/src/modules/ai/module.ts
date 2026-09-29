import express from 'express';
import { z } from 'zod';

import { getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { ServerModule } from '../../lib/module-contract';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { expireAiConversations } from './jobs';
import { aiOpenApiRoutes } from './openapi';
import { createAiProvider } from './provider';
import { createAiRouter } from './routes';
import { AiError, createAiService } from './service';

function createMountedAiRouter(dependencies: AuthDependencies): express.Router {
  const router = express.Router();
  const scoped = createWithOrg(dependencies.database);
  const service = createAiService(
    dependencies.database,
    createAiProvider(process.env),
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
    createAiRouter({
      service,
      context: async (request) => {
        const publicChat =
          request.method === 'POST' && request.path === '/chat';
        let accountId: string | null = null;
        try {
          accountId = (await requireSession(dependencies, request)).accountId;
        } catch {
          if (!publicChat)
            throw new AiError(401, 'UNAUTHORIZED', 'Sign in required');
        }
        const parsed = z.uuid().safeParse(request.get('X-Athlentry-Org'));
        if (!parsed.success)
          throw new AiError(404, 'NOT_FOUND', 'Organization not found');
        if (accountId) {
          const member = await scoped(
            {
              orgId: parsed.data,
              actor: { accountId },
            },
            (trx) =>
              trx
                .selectFrom('org_memberships')
                .select('id')
                .where('org_id', '=', parsed.data)
                .where('account_id', '=', accountId)
                .where('status', '=', 'active')
                .executeTakeFirst(),
          );
          if (!member && publicChat) accountId = null;
          else if (!member)
            throw new AiError(404, 'NOT_FOUND', 'Organization not found');
        }
        const context = {
          orgId: parsed.data,
          actor: {
            accountId: accountId ?? '00000000-0000-0000-0000-000000000000',
          },
        };
        if (!accountId) {
          const publicProgram = await scoped(context, (trx) =>
            trx
              .selectFrom('programs')
              .select('id')
              .where('org_id', '=', context.orgId)
              .where('visibility', '=', 'public')
              .where('status', 'in', [
                'published',
                'registration_open',
                'registration_closed',
                'in_progress',
              ])
              .executeTakeFirst(),
          );
          if (!publicProgram)
            throw new AiError(404, 'NOT_FOUND', 'Organization not found');
        }
        return { ...context, anonymous: accountId === null };
      },
    }),
  );
  return router;
}

export const moduleDefinition = {
  name: 'ai',
  path: '/api/v1/ai',
  router: createMountedAiRouter,
  jobs: [
    {
      name: 'ai.expire-conversations',
      cron: '0 * * * *',
      run: async () => expireAiConversations(getDatabase()),
    },
  ],
  permissions: [],
  errorCodes: [],
  openapiRoutes: aiOpenApiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
