import { apiErrorSchema } from '@shared/schemas/errors';
import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import {
  actionCenterMutationResponseSchema,
  actionCenterResponseSchema,
} from './schema';
import { loadActionCenter, runActionCenterReminder } from './service';

function requestContext(orgId: string, accountId: string): OrgContext {
  return { orgId, actor: { accountId } };
}

function sendError(response: express.Response, error: unknown): void {
  const status =
    error instanceof z.ZodError
      ? 400
      : error &&
          typeof error === 'object' &&
          'status' in error &&
          typeof error.status === 'number'
        ? error.status
        : 500;
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code in
      {
        VALIDATION_ERROR: true,
        NOT_FOUND: true,
        UNAUTHENTICATED: true,
        FORBIDDEN: true,
        CONFLICT: true,
        DEPENDENCY_UNAVAILABLE: true,
      }
      ? error.code
      : status === 400
        ? 'VALIDATION_ERROR'
        : status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 404
              ? 'NOT_FOUND'
              : status === 409
                ? 'CONFLICT'
                : status === 503
                  ? 'DEPENDENCY_UNAVAILABLE'
                  : 'INTERNAL_ERROR';
  response.status(status).json(
    apiErrorSchema.parse({
      error: {
        code,
        message:
          status >= 500
            ? 'The request could not be completed'
            : error instanceof Error
              ? error.message
              : 'Request failed',
      },
    }),
  );
}

export function createActionCenterRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  const withOrg = createWithOrg(dependencies.database);

  router.get('/orgs/:orgId/action-center', (request, response) => {
    void (async () => {
      const session = await requireSession(dependencies, request);
      const context = requestContext(
        z.uuid().parse(request.params.orgId),
        session.accountId,
      );
      const result = await loadActionCenter(
        context,
        withOrg,
        dependencies.clock(),
      );
      response
        .setHeader('Cache-Control', 'no-store')
        .json(actionCenterResponseSchema.parse(result));
    })().catch((error: unknown) => {
      sendError(response, error);
    });
  });

  function reminderHandler(
    action:
      | 'past_due_reminders'
      | 'failed_installment_contacts'
      | 'staff_compliance_reminders',
  ) {
    return (request: express.Request, response: express.Response) => {
      void (async () => {
        z.strictObject({}).parse(request.body);
        const session = await requireSession(dependencies, request);
        const context = requestContext(
          z.uuid().parse(request.params.orgId),
          session.accountId,
        );
        const result = await runActionCenterReminder(
          context,
          action,
          withOrg,
          dependencies.clock(),
        );
        response
          .setHeader('Cache-Control', 'no-store')
          .json(actionCenterMutationResponseSchema.parse(result));
      })().catch((error: unknown) => {
        sendError(response, error);
      });
    };
  }

  router.post(
    '/orgs/:orgId/action-center/actions/past-due-reminders',
    reminderHandler('past_due_reminders'),
  );
  router.post(
    '/orgs/:orgId/action-center/actions/failed-installment-contacts',
    reminderHandler('failed_installment_contacts'),
  );
  router.post(
    '/orgs/:orgId/action-center/actions/staff-compliance-reminders',
    reminderHandler('staff_compliance_reminders'),
  );

  return router;
}
