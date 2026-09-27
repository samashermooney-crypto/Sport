import { apiErrorSchema } from '@shared/schemas/errors';
import express from 'express';
import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';

import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { StripeSdkGateway } from '../../integrations/stripe/sdk.js';
import { requestImpersonation } from '../../lib/tenant-guard.js';
import { requireSession } from '../auth/routes.js';
import type { AuthDependencies } from '../auth/routes.js';

import { PostgresCreditRefundRepository } from './credit-refund-repo.js';
import { CreditRefundService } from './credit-refunds.js';
import {
  OfflinePaymentConflictError,
  PostgresOfflinePayments,
} from './offline-payments.js';
import { PostgresRefundApprovalPolicy } from './refund-approval-repo.js';
import { PostgresRefundAttemptStore } from './refund-attempt-repo.js';
import { PostgresRefundRecordStore } from './refund-record-repo.js';
import { PostgresRefundSourceReader } from './refund-source-repo.js';
import {
  refundProposal,
  RefundConflictError,
  StripeRefundService,
} from './refunds.js';
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
export const refundBodySchema = z.discriminatedUnion('destination', [
  z.strictObject({
    destination: z.literal('original_method'),
    paymentId: z.uuid(),
    cancellationDate: z.iso.date(),
  }),
  z.strictObject({
    destination: z.literal('credit'),
    paymentId: z.uuid(),
    cancellationDate: z.iso.date(),
    recipient: z.enum(['account', 'household']),
  }),
]);
export const refundResponseSchema = z.discriminatedUnion('destination', [
  z.strictObject({
    destination: z.literal('original_method'),
    refundId: z.string().startsWith('re_'),
    status: z.string(),
    amountCents: z.number().int().positive(),
  }),
  z.strictObject({
    destination: z.literal('credit'),
    refundId: z.uuid(),
    creditId: z.uuid(),
    amountCents: z.number().int().positive(),
  }),
]);
export const refundApprovalResponseSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['pending', 'approved', 'rejected']),
  amountCents: z.number().int().positive(),
});
export const refundApprovalDecisionSchema = z.strictObject({
  approved: z.literal(true),
});

class FinanceDependencyError extends Error {
  readonly status = 503;
}

function testGateway(): PaymentsGateway {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret || !secret.startsWith('sk_test_'))
    throw new FinanceDependencyError('Stripe test gateway is unavailable');
  return new StripeSdkGateway(secret, new Stripe(secret));
}

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
      : error instanceof OfflinePaymentConflictError ||
          error instanceof RefundConflictError
        ? 409
        : error instanceof FinanceDependencyError
          ? 503
          : error instanceof z.ZodError || error instanceof RangeError
            ? 400
            : error instanceof Error &&
                'status' in error &&
                error.status === 401
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
              : status === 503
                ? 'DEPENDENCY_UNAVAILABLE'
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
  gatewayFactory: () => PaymentsGateway = testGateway,
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
  router.post('/orgs/:orgId/refunds', async (request, response) => {
    try {
      if (
        !writeOriginValid(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const input = refundBodySchema.parse(request.body as unknown);
      const idempotencyKey = z.uuid().parse(request.get('Idempotency-Key'));
      const context = { orgId, actor: { accountId: session.accountId } };
      await requireFinanceStaff(dependencies.database, context);
      const reader = new PostgresRefundSourceReader(
        dependencies.database,
        context,
      );
      const approvals = new PostgresRefundApprovalPolicy(dependencies.database);
      const approvedByAccountId = await approvals.approvedByKey(
        orgId,
        idempotencyKey,
        session.accountId,
      );
      const common = {
        orgId,
        paymentId: input.paymentId,
        cancellationDate: input.cancellationDate,
        requestedByAccountId: session.accountId,
        ...(approvedByAccountId ? { approvedByAccountId } : {}),
        idempotencyKey,
      };
      if (input.destination === 'credit') {
        const service = new CreditRefundService(
          reader,
          approvals,
          new PostgresCreditRefundRepository(dependencies.database, context),
        );
        const result = await service.refund({
          ...common,
          recipient: input.recipient,
        });
        response.status(201).json(
          refundResponseSchema.parse({
            destination: 'credit',
            refundId: result.refundId,
            creditId: result.creditId,
            amountCents: result.amountCents,
          }),
        );
        return;
      }
      const service = new StripeRefundService(
        reader,
        approvals,
        new PostgresRefundAttemptStore(dependencies.database, context),
        gatewayFactory(),
        new PostgresRefundRecordStore(dependencies.database, context),
      );
      const result = await service.refund(common);
      response.status(201).json(
        refundResponseSchema.parse({
          destination: 'original_method',
          refundId: result.id,
          status: result.status,
          amountCents: result.proposal.totalCents,
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/orgs/:orgId/refund-approvals', async (request, response) => {
    try {
      if (
        !writeOriginValid(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const input = refundBodySchema.parse(request.body as unknown);
      const operationKey = z.uuid().parse(request.get('Idempotency-Key'));
      const context = { orgId, actor: { accountId: session.accountId } };
      await requireFinanceStaff(dependencies.database, context);
      const source = await new PostgresRefundSourceReader(
        dependencies.database,
        context,
      ).load(orgId, input.paymentId);
      if (!source) throw new RefundConflictError('Payment not found');
      const proposal = refundProposal(source, input.cancellationDate);
      if (proposal.totalCents <= source.approvalThresholdCents)
        throw new RefundConflictError(
          'Refund does not require second approval',
        );
      const result = await new PostgresRefundApprovalPolicy(
        dependencies.database,
      ).request({
        orgId,
        paymentId: input.paymentId,
        operationKey,
        destination: input.destination,
        recipient: input.destination === 'credit' ? input.recipient : null,
        cancellationDate: input.cancellationDate,
        requestedByAccountId: session.accountId,
        proposal,
      });
      response.status(201).json(refundApprovalResponseSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post(
    '/orgs/:orgId/refund-approvals/:approvalId/approve',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        if (
          !session.elevatedUntil ||
          session.elevatedUntil <= dependencies.clock()
        )
          throw new FinanceAccessError();
        const orgId = z.uuid().parse(request.params.orgId);
        const approvalId = z.uuid().parse(request.params.approvalId);
        await new PostgresRefundApprovalPolicy(dependencies.database).approve(
          orgId,
          approvalId,
          session.accountId,
        );
        response.json(refundApprovalDecisionSchema.parse({ approved: true }));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  return router;
}
