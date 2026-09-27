import {
  aiApplyResponseSchema,
  aiChatBodySchema,
  aiChatResponseSchema,
  aiConversationListSchema,
  aiDraftResponseSchema,
  aiFormDraftQuerySchema,
  aiStatusSchema,
  aiTranslateBodySchema,
  aiTranslateResponseSchema,
} from '@shared/schemas/growth';
import express from 'express';
import { z } from 'zod';

import { getDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { ServerModule } from '../../lib/module-contract';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { expireAiConversations } from './jobs';
import { createAiProvider } from './provider';
import { createAiRouter } from './routes';
import { AiError, createAiService } from './service';

const openapiRoutes = [
  {
    method: 'get',
    path: '/api/v1/ai/status',
    summary: 'Get optional AI feature availability',
    response: aiStatusSchema,
  },
  {
    method: 'post',
    path: '/api/v1/ai/form-drafts',
    summary: 'Draft a form from an uploaded document',
    response: aiDraftResponseSchema,
    status: 201,
    requestContentType: 'application/octet-stream',
    requestBinary: true,
    query: { name: aiFormDraftQuerySchema.shape.name },
  },
  {
    method: 'post',
    path: '/api/v1/ai/form-drafts/{id}/apply',
    summary: 'Apply a reviewed form draft',
    response: aiApplyResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/ai/form-drafts/{id}/discard',
    summary: 'Discard a form draft',
    response: z.null(),
    status: 204,
  },
  {
    method: 'post',
    path: '/api/v1/ai/translate',
    summary: 'Translate editable text',
    body: aiTranslateBodySchema,
    response: aiTranslateResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/ai/chat',
    summary: 'Ask the organization help assistant',
    body: aiChatBodySchema,
    response: aiChatResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/ai/conversations',
    summary: 'List help assistant conversations',
    response: aiConversationListSchema,
  },
];

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
        let accountId: string;
        try {
          accountId = (await requireSession(dependencies, request)).accountId;
        } catch {
          throw new AiError(401, 'UNAUTHORIZED', 'Sign in required');
        }
        const parsed = z.uuid().safeParse(request.get('X-Athlentry-Org'));
        if (!parsed.success)
          throw new AiError(404, 'NOT_FOUND', 'Organization not found');
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
          throw new AiError(404, 'NOT_FOUND', 'Organization not found');
        return context;
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
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
