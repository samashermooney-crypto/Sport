import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';

import { AiError } from './service';
import type { AiService } from './service';

const translateSchema = z.object({
  text: z.string().min(1).max(20_000),
  target: z.enum(['en', 'es']),
});

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  conversationId: z.uuid().optional(),
  visitorKey: z.string().max(200).optional(),
});

export interface AiRoutesDependencies {
  service: AiService;
  context(request: Request): Promise<OrgContext>;
}

export function createAiRouter(dependencies: AiRoutesDependencies) {
  const router = express.Router();

  const wrap =
    (
      handler: (
        request: Request,
        response: Response,
        context: OrgContext,
      ) => Promise<void>,
    ) =>
    async (
      request: Request,
      response: Response,
      next: express.NextFunction,
    ) => {
      try {
        await handler(request, response, await dependencies.context(request));
      } catch (error) {
        next(error);
      }
    };

  router.get(
    '/status',
    wrap(async (_request, response, context) => {
      response.json(dependencies.service.status(context.orgId));
    }),
  );

  router.post(
    '/form-drafts',
    express.raw({ type: () => true, limit: '10mb' }),
    wrap(async (request, response, context) => {
      const fileName =
        typeof request.query.name === 'string' && request.query.name.length > 0
          ? request.query.name.slice(0, 200)
          : 'document';
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0)
        throw new AiError(400, 'VALIDATION_ERROR', 'Upload body is missing');
      response.status(201).json(
        await dependencies.service.draftForm(
          context.orgId,
          context.actor.accountId,
          fileName,
          new Uint8Array(request.body),
        ),
      );
    }),
  );

  router.post(
    '/form-drafts/:id/apply',
    express.json({ limit: '8kb' }),
    wrap(async (request, response, context) => {
      response.json(
        await dependencies.service.applyDraft(
          context.orgId,
          context.actor.accountId,
          z.uuid().parse(request.params.id),
        ),
      );
    }),
  );

  router.post(
    '/form-drafts/:id/discard',
    express.json({ limit: '8kb' }),
    wrap(async (request, response, context) => {
      await dependencies.service.discardDraft(
        context.orgId,
        context.actor.accountId,
        z.uuid().parse(request.params.id),
      );
      response.status(204).end();
    }),
  );

  router.post(
    '/translate',
    express.json({ limit: '64kb' }),
    wrap(async (request, response, context) => {
      const input = translateSchema.parse(request.body);
      response.json(
        await dependencies.service.translate(
          context.orgId,
          context.actor.accountId,
          input,
        ),
      );
    }),
  );

  router.post(
    '/chat',
    express.json({ limit: '16kb' }),
    wrap(async (request, response, context) => {
      const input = chatSchema.parse(request.body);
      response.json(
        await dependencies.service.chat(
          context.orgId,
          context.actor.accountId,
          input.visitorKey ?? null,
          input.message,
          input.conversationId,
        ),
      );
    }),
  );

  router.get(
    '/conversations',
    wrap(async (_request, response, context) => {
      response.json({
        conversations: await dependencies.service.listConversations(
          context.orgId,
          context.actor.accountId,
        ),
      });
    }),
  );

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: express.NextFunction,
    ) => {
      if (error instanceof AiError) {
        response
          .status(error.status)
          .json({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        response
          .status(400)
          .json({ error: 'VALIDATION_ERROR', issues: error.issues });
        return;
      }
      next(error);
    },
  );
  return router;
}
