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

import { PostgresPaymentAttemptStore } from './attempt-repo.js';
import { ConnectConflictError, ConnectOnboardingService } from './connect.js';
import { PostgresCreditRefundRepository } from './credit-refund-repo.js';
import { CreditRefundService } from './credit-refunds.js';
import { PostgresFrozenChargeReader } from './frozen-charge-repo.js';
import {
  JournalExportError,
  payoutJournalCsv,
  payoutJournalLines,
} from './journal-export.js';
import {
  OfflinePaymentConflictError,
  PostgresOfflinePayments,
} from './offline-payments.js';
import {
  PayerMethodConflictError,
  PayerMethodsService,
} from './payer-methods.js';
import { PostgresPayerProfileRepository } from './payer-repo.js';
import { PostgresSavedPaymentMethodRepository } from './payment-method-repo.js';
import { PostgresPaymentRecordStore } from './payment-repo.js';
import { PostgresPayoutReconciliation } from './reconciliation.js';
import { PostgresRefundApprovalPolicy } from './refund-approval-repo.js';
import { PostgresRefundAttemptStore } from './refund-attempt-repo.js';
import { PostgresRefundRecordStore } from './refund-record-repo.js';
import { PostgresRefundSourceReader } from './refund-source-repo.js';
import {
  refundProposal,
  RefundConflictError,
  StripeRefundService,
} from './refunds.js';
import { PostgresConnectAccountRepository } from './repo.js';
import { CheckoutPaymentService, PaymentConflictError } from './service.js';
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
export const payoutJournalBodySchema = z.strictObject({
  bank: z.string().trim().min(1).max(80),
  stripeClearing: z.string().trim().min(1).max(80),
  processingFees: z.string().trim().min(1).max(80),
  transactionTypes: z.record(
    z.string().min(1),
    z.string().trim().min(1).max(80),
  ),
  name: z.string().max(120).optional(),
  className: z.string().max(120).optional(),
});
export const payoutJournalResponseSchema = z.strictObject({
  csv: z.string().min(1),
  journalNo: z.string().min(1),
  lineCount: z.number().int().nonnegative(),
});
export const setupIntentResponseSchema = z.strictObject({
  id: z.string().startsWith('seti_'),
  clientSecret: z.string().min(1),
});
export const savedPaymentMethodSchema = z.strictObject({
  id: z.string().startsWith('pm_'),
  type: z.enum(['card', 'us_bank_account', 'link']),
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  expMonth: z.number().int().nullable(),
  expYear: z.number().int().nullable(),
  bankName: z.string().nullable(),
});
export const savedPaymentMethodsResponseSchema = z.strictObject({
  methods: z.array(savedPaymentMethodSchema),
});
export const paymentMethodActionResponseSchema = z.strictObject({
  success: z.literal(true),
});
export const connectLinkResponseSchema = z.strictObject({
  url: z.url().startsWith('https://'),
});
export const connectStatusResponseSchema = z.strictObject({
  stripeAccountId: z.string().startsWith('acct_').nullable(),
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  detailsSubmitted: z.boolean(),
  requirementsDue: z.array(z.string()),
  disabledReason: z.string().nullable(),
});
export const checkoutPaymentBodySchema = z.strictObject({
  checkoutId: z.uuid(),
  invoiceId: z.uuid(),
  saveForAutopay: z.boolean(),
});
export const checkoutPaymentResponseSchema = z.strictObject({
  id: z.string().startsWith('pi_'),
  clientSecret: z.string().min(1),
  status: z.string().min(1),
  quote: z.strictObject({
    baseCents: z.number().int().nonnegative(),
    serviceFeeCents: z.number().int().nonnegative(),
    taxCents: z.number().int().nonnegative(),
    amountCents: z.number().int().positive(),
    applicationFeeCents: z.number().int().nonnegative(),
  }),
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
          error instanceof RefundConflictError ||
          error instanceof JournalExportError ||
          error instanceof PayerMethodConflictError ||
          error instanceof ConnectConflictError ||
          error instanceof PaymentConflictError
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
  const payerMethods = () =>
    new PayerMethodsService(
      new PostgresPayerProfileRepository(dependencies.database),
      gatewayFactory(),
      new PostgresSavedPaymentMethodRepository(dependencies.database),
    );
  const connect = (orgId: string, accountId: string) => {
    const repository = new PostgresConnectAccountRepository(
      dependencies.database,
      { orgId, actor: { accountId } },
    );
    const base = dependencies.appUrl.replace(/\/$/, '');
    return {
      repository,
      service: new ConnectOnboardingService(repository, gatewayFactory(), {
        returnUrl: (id) => `${base}/orgs/${id}/money/connect/return`,
        refreshUrl: (id) => `${base}/orgs/${id}/money/connect/refresh`,
      }),
    };
  };
  router.post(
    '/orgs/:orgId/checkout-payment-intents',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const input = checkoutPaymentBodySchema.parse(request.body as unknown);
        const idempotencyKey = z.uuid().parse(request.get('Idempotency-Key'));
        const context = { orgId, actor: { accountId: session.accountId } };
        const result = await new CheckoutPaymentService(
          new PostgresFrozenChargeReader(dependencies.database, context),
          new PostgresPaymentAttemptStore(dependencies.database, context),
          gatewayFactory(),
          new PostgresPaymentRecordStore(dependencies.database, context),
        ).create({
          orgId,
          checkoutId: input.checkoutId,
          invoiceId: input.invoiceId,
          accountId: session.accountId,
          idempotencyKey,
          saveForAutopay: input.saveForAutopay,
        });
        response.status(201).json(checkoutPaymentResponseSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post('/me/setup-intents', async (request, response) => {
    try {
      if (
        !writeOriginValid(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const idempotencyKey = z.uuid().parse(request.get('Idempotency-Key'));
      const account = await dependencies.database
        .selectFrom('accounts')
        .select('email')
        .where('id', '=', session.accountId)
        .executeTakeFirstOrThrow();
      const result = await payerMethods().createSetupIntent({
        accountId: session.accountId,
        email: account.email,
        idempotencyKey,
      });
      response.status(201).json(setupIntentResponseSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/me/payment-methods', async (request, response) => {
    try {
      if (requestImpersonation(request)) throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const methods = await payerMethods().list(session.accountId);
      response.json(savedPaymentMethodsResponseSchema.parse({ methods }));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post(
    '/me/payment-methods/:paymentMethodId/default',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const id = z
          .string()
          .regex(/^pm_[A-Za-z0-9_]+$/)
          .parse(request.params.paymentMethodId);
        await payerMethods().setDefault(session.accountId, id);
        response.json(
          paymentMethodActionResponseSchema.parse({ success: true }),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.delete(
    '/me/payment-methods/:paymentMethodId',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const id = z
          .string()
          .regex(/^pm_[A-Za-z0-9_]+$/)
          .parse(request.params.paymentMethodId);
        await payerMethods().remove(session.accountId, id);
        response.json(
          paymentMethodActionResponseSchema.parse({ success: true }),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post('/orgs/:orgId/connect/onboarding', async (request, response) => {
    try {
      if (
        !writeOriginValid(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      await requireFinanceStaff(dependencies.database, {
        orgId,
        actor: { accountId: session.accountId },
      });
      const account = await dependencies.database
        .selectFrom('accounts')
        .select('email')
        .where('id', '=', session.accountId)
        .executeTakeFirstOrThrow();
      const result = await connect(orgId, session.accountId).service.create(
        orgId,
        account.email,
      );
      response.status(201).json(connectLinkResponseSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/orgs/:orgId/connect/continue', async (request, response) => {
    try {
      if (
        !writeOriginValid(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      await requireFinanceStaff(dependencies.database, {
        orgId,
        actor: { accountId: session.accountId },
      });
      const result = await connect(orgId, session.accountId).service.continue(
        orgId,
      );
      response.json(connectLinkResponseSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/orgs/:orgId/connect/dashboard', async (request, response) => {
    try {
      if (
        !writeOriginValid(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      await requireFinanceStaff(dependencies.database, {
        orgId,
        actor: { accountId: session.accountId },
      });
      const result = await connect(orgId, session.accountId).service.dashboard(
        orgId,
      );
      response.json(connectLinkResponseSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/orgs/:orgId/connect/status', async (request, response) => {
    try {
      if (requestImpersonation(request)) throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      await requireFinanceStaff(dependencies.database, {
        orgId,
        actor: { accountId: session.accountId },
      });
      const connected = connect(orgId, session.accountId);
      const stored = await connected.repository.load(orgId);
      if (!stored) {
        response.json(
          connectStatusResponseSchema.parse({
            stripeAccountId: null,
            chargesEnabled: false,
            payoutsEnabled: false,
            detailsSubmitted: false,
            requirementsDue: [],
            disabledReason: null,
          }),
        );
        return;
      }
      const latest = await connected.service.refresh(
        orgId,
        stored.stripeAccountId,
      );
      response.json(
        connectStatusResponseSchema.parse({
          stripeAccountId: latest.stripeAccountId,
          chargesEnabled: latest.chargesEnabled,
          payoutsEnabled: latest.payoutsEnabled,
          detailsSubmitted: latest.detailsSubmitted,
          requirementsDue: latest.requirementsDue,
          disabledReason: latest.disabledReason,
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
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
  router.post(
    '/orgs/:orgId/payouts/:payoutId/journal-export',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const payoutId = z
          .string()
          .regex(/^po_[A-Za-z0-9_]+$/)
          .parse(request.params.payoutId);
        const input = payoutJournalBodySchema.parse(request.body as unknown);
        const context = { orgId, actor: { accountId: session.accountId } };
        await requireFinanceStaff(dependencies.database, context);
        const report = await new PostgresPayoutReconciliation(
          dependencies.database,
          context,
        ).read(payoutId);
        const lines = payoutJournalLines(
          report,
          {
            bank: input.bank,
            stripeClearing: input.stripeClearing,
            processingFees: input.processingFees,
            transactionTypes: input.transactionTypes,
          },
          {
            ...(input.name ? { name: input.name } : {}),
            ...(input.className ? { className: input.className } : {}),
          },
        );
        response.json(
          payoutJournalResponseSchema.parse({
            csv: payoutJournalCsv(lines),
            journalNo: `PAYOUT-${payoutId}`,
            lineCount: lines.length,
          }),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  return router;
}
