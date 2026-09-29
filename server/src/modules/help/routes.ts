import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';

import { HelpError } from './service';
import type { HelpService } from './service';

const supportSchema = z.object({
  kind: z.enum(['support', 'concierge_import']).default('support'),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  contactEmail: z.email().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export interface HelpRoutesDependencies {
  service: HelpService;
  context(request: Request): Promise<OrgContext>;
}

export function createHelpRouter(dependencies: HelpRoutesDependencies) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));

  const wrap =
    (
      handler: (
        request: Request,
        response: Response,
        context: OrgContext,
      ) => void | Promise<void>,
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
    '/articles',
    wrap((request, response) => {
      const locale =
        typeof request.query.locale === 'string' ? request.query.locale : 'en';
      const audience =
        typeof request.query.audience === 'string'
          ? request.query.audience
          : undefined;
      response.json(dependencies.service.catalog(locale, audience));
    }),
  );

  router.get(
    '/articles/:slug',
    wrap((request, response) => {
      const locale =
        typeof request.query.locale === 'string' ? request.query.locale : 'en';
      const slugParam = request.params.slug;
      const slug = Array.isArray(slugParam)
        ? (slugParam[0] ?? '')
        : (slugParam ?? '');
      const article = dependencies.service.getArticle(slug, locale);
      if (!article) throw new HelpError(404, 'NOT_FOUND', 'Article not found');
      response.json(article);
    }),
  );

  router.get(
    '/search',
    wrap((request, response) => {
      const query = typeof request.query.q === 'string' ? request.query.q : '';
      const locale =
        typeof request.query.locale === 'string' ? request.query.locale : 'en';
      response.json({ results: dependencies.service.search(query, locale) });
    }),
  );

  router.post(
    '/support-requests',
    wrap(async (request, response, context) => {
      const input = supportSchema.parse(request.body);
      response
        .status(201)
        .json(
          await dependencies.service.createSupportRequest(
            context.orgId,
            context.actor.accountId,
            input,
          ),
        );
    }),
  );

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: express.NextFunction,
    ) => {
      if (error instanceof HelpError) {
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
