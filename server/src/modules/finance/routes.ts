import { apiErrorSchema } from '@shared/schemas/errors';
import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard.js';
import { requireSession } from '../auth/routes.js';
import type { AuthDependencies } from '../auth/routes.js';

import {
  OfflinePaymentConflictError,
  PostgresOfflinePayments,
} from './offline-payments.js';
import { FinanceAccessError, requireFinanceStaff } from './staff-access.js';

export const offlinePaymentBodySchema = z.strictObject({
  invoiceId: z.uuid(),
  method: z.enum(['cash', 'check', 'external']),
  amountCents: z.number().int().positive(),
  reference: z.string().max(200).nullable().optional(),
});
export const offlinePaymentReceiptSchema = z.strictObject({
  paymentId: z.uuid(),
  receiptNumber: z.number().int().positive(),
  amountCents: z.number().int().positive(),
});

function writeOriginValid(request: Request, appUrl: string): boolean {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearer && !request.get('Origin')))
  );
}

function sendError(response: Response, error: unknown): void {
  const status =
    error instanceof FinanceAccessError
      ? 403
      : error instanceof OfflinePaymentConflictError
        ? 409
        : error instanceof z.ZodError || error instanceof RangeError
          ? 400
          : error instanceof Error && 'status' in error && error.status === 401
            ? 401
            : 500;
  response.status(status).json(
    apiErrorSchema.parse({
      error: {
        code:
          status === 403
            ? 'FORBIDDEN'
            : status === 409
              ? 'CONFLICT'
              : status === 400
                ? 'VALIDATION_ERROR'
                : status === 401
                  ? 'UNAUTHENTICATED'
                  : 'INTERNAL_ERROR',
        message:
          status === 500
            ? 'The request could not be completed'
            : error instanceof Error
              ? error.message
              : 'Request failed',
      },
    }),
  );
}

export function createFinanceRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.post('/orgs/:orgId/offline-payments', async (request, response) => {
    try {
      if (!writeOriginValid(request, dependencies.appUrl))
        throw new FinanceAccessError();
      if (requestImpersonation(request)) throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const input = offlinePaymentBodySchema.parse(request.body as unknown);
      const idempotencyKey = z.uuid().parse(request.get('Idempotency-Key'));
      const context = { orgId, actor: { accountId: session.accountId } };
      await requireFinanceStaff(dependencies.database, context);
      const receipt = await new PostgresOfflinePayments(
        dependencies.database,
        context,
      ).record({
        orgId,
        invoiceId: input.invoiceId,
        method: input.method,
        amountCents: input.amountCents,
        reference: input.reference ?? null,
        idempotencyKey,
      });
      response.status(201).json(offlinePaymentReceiptSchema.parse(receipt));
    } catch (error) {
      sendError(response, error);
    }
  });
  return router;
}
