import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';

import { OnboardingError, ONBOARDING_ITEMS } from './service';
import type { OnboardingService } from './service';

const keySchema = z.enum(
  ONBOARDING_ITEMS.map((item) => item.key) as [
    (typeof ONBOARDING_ITEMS)[number]['key'],
  ],
);

export interface OnboardingRoutesDependencies {
  service: OnboardingService;
  context(request: Request): Promise<OrgContext>;
}

export function createOnboardingRouter(
  dependencies: OnboardingRoutesDependencies,
) {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));

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
    '/checklist',
    wrap(async (_request, response, context) => {
      response.json(
        await dependencies.service.getChecklist(
          context.orgId,
          context.actor.accountId,
        ),
      );
    }),
  );

  router.post(
    '/checklist/:key/dismiss',
    wrap(async (request, response, context) => {
      await dependencies.service.dismiss(
        context.orgId,
        context.actor.accountId,
        keySchema.parse(request.params.key),
      );
      response.status(204).end();
    }),
  );

  router.post(
    '/checklist/:key/restore',
    wrap(async (request, response, context) => {
      await dependencies.service.restore(
        context.orgId,
        context.actor.accountId,
        keySchema.parse(request.params.key),
      );
      response.status(204).end();
    }),
  );

  router.post(
    '/checklist/dismiss-all',
    wrap(async (_request, response, context) => {
      await dependencies.service.dismissAll(
        context.orgId,
        context.actor.accountId,
      );
      response.status(204).end();
    }),
  );

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: express.NextFunction,
    ) => {
      if (error instanceof OnboardingError) {
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
