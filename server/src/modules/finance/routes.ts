import { apiErrorSchema } from '@shared/schemas/errors';
import express from 'express';
import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import { StripeSdkGateway } from '../../integrations/stripe/sdk.js';
import { requestImpersonation } from '../../lib/tenant-guard.js';
import { requireSession } from '../auth/routes.js';
import type { AuthDependencies } from '../auth/routes.js';

import { AidAwardConflictError, PostgresAidAwards } from './aid-awards.js';
import {
  aidProgramCreateSchema,
  aidProgramListSchema,
  aidProgramReplaceSchema,
  aidProgramSchema,
  AidProgramConflictError,
  PostgresAidPrograms,
} from './aid-programs.js';
import {
  aidDecisionBodySchema,
  aidDecisionResponseSchema,
  aidQueueSchema,
  AidReviewConflictError,
  PostgresAidReview,
} from './aid-review.js';
import { PostgresPaymentAttemptStore } from './attempt-repo.js';
import { ConnectConflictError, ConnectOnboardingService } from './connect.js';
import { PostgresCreditRefundRepository } from './credit-refund-repo.js';
import { CreditRefundService } from './credit-refunds.js';
import { PostgresFrozenChargeReader } from './frozen-charge-repo.js';
import {
  installmentTemplateBodySchema,
  installmentTemplateListSchema,
  installmentTemplateSchema,
  InstallmentTemplateConflictError,
  PostgresInstallmentTemplates,
} from './installment-templates.js';
import {
  InvoiceConflictError,
  InvoiceNotFoundError,
  PostgresInvoiceRepository,
} from './invoice-repo.js';
import {
  JournalExportError,
  payoutJournalCsv,
  payoutJournalLines,
} from './journal-export.js';
import {
  OfflinePaymentConflictError,
  PostgresOfflinePayments,
} from './offline-payments.js';
import { PostgresPayerInvoices } from './payer-invoices.js';
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
import { refundTermsSchema } from './refund-terms.js';
import {
  refundProposal,
  RefundConflictError,
  StripeRefundService,
} from './refunds.js';
import { PostgresConnectAccountRepository } from './repo.js';
import { CheckoutPaymentService, PaymentConflictError } from './service.js';
import {
  FinanceAccessError,
  requireAidStaff,
  requireFinanceStaff,
} from './staff-access.js';

export const offlinePaymentBodySchema = z.strictObject({
  invoiceId: z.uuid(),
  method: z.enum(['cash', 'check', 'external']),
  amountCents: z.number().int().positive(),
  reference: z.string().max(200).nullable().optional(),
});
export const staffInvoiceBodySchema = z.strictObject({
  accountId: z.uuid(),
  householdId: z.uuid().optional(),
  dueOn: z.iso.date().optional(),
  memo: z.string().max(2000).optional(),
  refundTerms: refundTermsSchema,
  lines: z
    .array(
      z.strictObject({
        kind: z.enum([
          'registration',
          'add_on',
          'product',
          'team_fee',
          'tuition',
          'volunteer_buyout',
          'donation',
          'service_fee',
          'late_fee',
          'adjustment',
          'discount',
          'aid',
        ]),
        description: z.string().trim().min(1).max(500),
        amountCents: z
          .number()
          .int()
          .min(-Number.MAX_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER)
          .refine((value) => value !== 0),
        refundable: z.boolean(),
        parentLineIndex: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(100),
});
export const aidAwardBodySchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  decision: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('fixed'),
      amountCents: z.number().int().positive(),
    }),
    z.strictObject({
      kind: z.literal('percent'),
      bps: z.number().int().min(1).max(10_000),
      maxCents: z.number().int().positive(),
    }),
  ]),
});
export const aidAwardResponseSchema = z.strictObject({
  applicationId: z.uuid(),
  status: z.enum(['awarded', 'partially_awarded']),
  awardCents: z.number().int().positive(),
  awardKind: z.enum(['fixed', 'percent']),
  awardBps: z.number().int().min(1).max(10_000).nullable(),
  version: z.number().int().positive(),
});
export const staffInvoiceResponseSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  totalCents: z.number().int().nonnegative(),
  status: z.enum(['open', 'paid']),
});
export const invoiceDetailSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  accountId: z.uuid(),
  householdId: z.uuid().nullable(),
  status: z.enum([
    'draft',
    'open',
    'paid',
    'partially_paid',
    'past_due',
    'void',
    'uncollectible',
  ]),
  issuedAt: z.iso.datetime().nullable(),
  dueOn: z.iso.date().nullable(),
  subtotalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  serviceFeeCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  paidCents: z.number().int().nonnegative(),
  refundedCents: z.number().int().nonnegative(),
  creditAppliedCents: z.number().int().nonnegative(),
  balanceCents: z.number().int().nonnegative().nullable(),
  memo: z.string().nullable(),
  source: z.string(),
  version: z.number().int().positive(),
  voidedAt: z.iso.datetime().nullable(),
  voidReason: z.string().nullable(),
  lines: z.array(
    z.strictObject({
      id: z.uuid(),
      kind: z.string(),
      description: z.string(),
      amountCents: z.number().int(),
      refundable: z.boolean(),
      parentLineId: z.uuid().nullable(),
    }),
  ),
});
export const voidInvoiceBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});
export const voidInvoiceResponseSchema = z.strictObject({
  id: z.uuid(),
  status: z.literal('void'),
});
export const payerInvoiceListSchema = z.strictObject({
  invoices: z.array(
    z.strictObject({
      id: z.uuid(),
      number: z.number().int().positive(),
      status: z.enum([
        'open',
        'paid',
        'partially_paid',
        'past_due',
        'void',
        'uncollectible',
      ]),
      source: z.string(),
      issuedAt: z.iso.datetime().nullable(),
      dueOn: z.iso.date().nullable(),
      totalCents: z.number().int().nonnegative(),
      paidCents: z.number().int().nonnegative(),
      refundedCents: z.number().int().nonnegative(),
      creditAppliedCents: z.number().int().nonnegative(),
      balanceCents: z.number().int().nonnegative().nullable(),
    }),
  ),
  nextBeforeNumber: z.number().int().positive().nullable(),
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
  defaultMethodId: z.string().startsWith('pm_').nullable(),
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
          error instanceof PaymentConflictError ||
          error instanceof InstallmentTemplateConflictError ||
          error instanceof InvoiceConflictError ||
          error instanceof AidAwardConflictError ||
          error instanceof AidProgramConflictError ||
          error instanceof AidReviewConflictError
        ? 409
        : error instanceof InvoiceNotFoundError
          ? 404
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
              : status === 404
                ? 'NOT_FOUND'
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
  router.get('/orgs/:orgId/aid-programs', async (request, response) => {
    try {
      if (requestImpersonation(request)) throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const context = { orgId, actor: { accountId: session.accountId } };
      await requireAidStaff(dependencies.database, context);
      const seasonId =
        request.query.seasonId === undefined
          ? undefined
          : z.uuid().parse(request.query.seasonId);
      const programs = await new PostgresAidPrograms(
        dependencies.database,
        context,
      ).list(seasonId);
      response.json(aidProgramListSchema.parse({ programs }));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/orgs/:orgId/aid-programs', async (request, response) => {
    try {
      if (
        !writeOriginValid(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const body = aidProgramCreateSchema.parse(request.body as unknown);
      const key = z.uuid().parse(request.get('Idempotency-Key'));
      const context = { orgId, actor: { accountId: session.accountId } };
      await requireAidStaff(dependencies.database, context);
      const program = await new PostgresAidPrograms(
        dependencies.database,
        context,
      ).create(body, key);
      response.status(201).json(aidProgramSchema.parse(program));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.put(
    '/orgs/:orgId/aid-programs/:programId',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const programId = z.uuid().parse(request.params.programId);
        const body = aidProgramReplaceSchema.parse(request.body as unknown);
        const context = { orgId, actor: { accountId: session.accountId } };
        await requireAidStaff(dependencies.database, context);
        const program = await new PostgresAidPrograms(
          dependencies.database,
          context,
        ).replace(programId, body);
        response.json(aidProgramSchema.parse(program));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.get('/orgs/:orgId/aid-applications', async (request, response) => {
    try {
      if (requestImpersonation(request)) throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const context = { orgId, actor: { accountId: session.accountId } };
      await requireAidStaff(dependencies.database, context);
      const result = await new PostgresAidReview(
        dependencies.database,
        context,
      ).queue({
        seasonId:
          request.query.seasonId === undefined
            ? undefined
            : z.uuid().parse(request.query.seasonId),
        limit:
          request.query.limit === undefined
            ? 50
            : z.coerce.number().int().parse(request.query.limit),
        cursor:
          request.query.cursor === undefined
            ? undefined
            : z.string().parse(request.query.cursor),
      });
      response.json(aidQueueSchema.parse(result));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post(
    '/orgs/:orgId/aid-applications/:applicationId/decision',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const applicationId = z.uuid().parse(request.params.applicationId);
        const body = aidDecisionBodySchema.parse(request.body as unknown);
        const context = { orgId, actor: { accountId: session.accountId } };
        await requireAidStaff(dependencies.database, context);
        const result = await new PostgresAidReview(
          dependencies.database,
          context,
        ).decide(applicationId, body);
        response.json(aidDecisionResponseSchema.parse(result));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/aid-applications/:applicationId/award',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const applicationId = z.uuid().parse(request.params.applicationId);
        const input = aidAwardBodySchema.parse(request.body as unknown);
        const operationKey = z.uuid().parse(request.get('Idempotency-Key'));
        const context = { orgId, actor: { accountId: session.accountId } };
        await requireAidStaff(dependencies.database, context);
        const award = await new PostgresAidAwards(
          dependencies.database,
          context,
        ).award({
          orgId,
          applicationId,
          expectedVersion: input.expectedVersion,
          operationKey,
          decision: input.decision,
        });
        response.json(aidAwardResponseSchema.parse(award));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.get('/orgs/:orgId/me/invoices', async (request, response) => {
    try {
      if (requestImpersonation(request)) throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const beforeNumber = z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .parse(request.query.beforeNumber);
      const invoices = await new PostgresPayerInvoices(
        dependencies.database,
      ).list({
        orgId,
        accountId: session.accountId,
        ...(beforeNumber ? { beforeNumber } : {}),
      });
      response.json(payerInvoiceListSchema.parse(invoices));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/orgs/:orgId/invoices/:invoiceId', async (request, response) => {
    try {
      if (requestImpersonation(request)) throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const invoiceId = z.uuid().parse(request.params.invoiceId);
      const context = { orgId, actor: { accountId: session.accountId } };
      await requireFinanceStaff(dependencies.database, context);
      const invoice = await new PostgresInvoiceRepository(
        dependencies.database,
        context,
      ).read(orgId, invoiceId);
      response.json(invoiceDetailSchema.parse(invoice));
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post(
    '/orgs/:orgId/invoices/:invoiceId/void',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const invoiceId = z.uuid().parse(request.params.invoiceId);
        const input = voidInvoiceBodySchema.parse(request.body as unknown);
        const context = { orgId, actor: { accountId: session.accountId } };
        await requireFinanceStaff(dependencies.database, context);
        await new PostgresInvoiceRepository(
          dependencies.database,
          context,
        ).void({
          orgId,
          invoiceId,
          reason: input.reason,
          expectedVersion: input.expectedVersion,
        });
        response.json(
          voidInvoiceResponseSchema.parse({ id: invoiceId, status: 'void' }),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post('/orgs/:orgId/invoices', async (request, response) => {
    try {
      if (
        !writeOriginValid(request, dependencies.appUrl) ||
        requestImpersonation(request)
      )
        throw new FinanceAccessError();
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const input = staffInvoiceBodySchema.parse(request.body as unknown);
      const creationKey = z.uuid().parse(request.get('Idempotency-Key'));
      const context = { orgId, actor: { accountId: session.accountId } };
      await requireFinanceStaff(dependencies.database, context);
      const billable = await createWithOrg(dependencies.database)(
        context,
        async (trx) => {
          if (input.householdId) {
            const householdLink = await trx
              .selectFrom('person_account_links as pal')
              .innerJoin('household_members as hm', (join) =>
                join
                  .onRef('hm.org_id', '=', 'pal.org_id')
                  .onRef('hm.person_id', '=', 'pal.person_id'),
              )
              .innerJoin('households as h', (join) =>
                join
                  .onRef('h.org_id', '=', 'hm.org_id')
                  .onRef('h.id', '=', 'hm.household_id'),
              )
              .select('pal.id')
              .where('pal.org_id', '=', orgId)
              .where('pal.account_id', '=', input.accountId)
              .where('pal.revoked_at', 'is', null)
              .where('pal.verified_at', 'is not', null)
              .where('hm.household_id', '=', input.householdId)
              .where('hm.financially_responsible', '=', true)
              .where('h.status', '=', 'active')
              .executeTakeFirst();
            return Boolean(householdLink);
          }
          const member = await trx
            .selectFrom('org_memberships')
            .select('id')
            .where('org_id', '=', orgId)
            .where('account_id', '=', input.accountId)
            .where('status', '=', 'active')
            .executeTakeFirst();
          if (member) return true;
          const participant = await trx
            .selectFrom('person_account_links')
            .select('id')
            .where('org_id', '=', orgId)
            .where('account_id', '=', input.accountId)
            .where('revoked_at', 'is', null)
            .where('verified_at', 'is not', null)
            .executeTakeFirst();
          return Boolean(participant);
        },
      );
      if (!billable) throw new FinanceAccessError();
      const invoice = await new PostgresInvoiceRepository(
        dependencies.database,
        context,
      ).issue({
        orgId,
        accountId: input.accountId,
        source: 'staff',
        creationKey,
        refundTerms: input.refundTerms,
        lines: input.lines.map((line) => ({
          kind: line.kind,
          description: line.description,
          amountCents: line.amountCents,
          refundable: line.refundable,
          ...(line.parentLineIndex === undefined
            ? {}
            : { parentLineIndex: line.parentLineIndex }),
        })),
        ...(input.householdId ? { householdId: input.householdId } : {}),
        ...(input.dueOn ? { dueOn: input.dueOn } : {}),
        ...(input.memo ? { memo: input.memo } : {}),
      });
      response.status(201).json(
        staffInvoiceResponseSchema.parse({
          id: invoice.id,
          number: invoice.number,
          totalCents: invoice.totalCents,
          status: invoice.status,
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get(
    '/orgs/:orgId/installment-templates',
    async (request, response) => {
      try {
        if (requestImpersonation(request)) throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const context = { orgId, actor: { accountId: session.accountId } };
        const allowed = await createWithOrg(dependencies.database)(
          context,
          async (trx) => {
            const membership = await trx
              .selectFrom('org_memberships')
              .select('id')
              .where('org_id', '=', orgId)
              .where('account_id', '=', session.accountId)
              .where('status', '=', 'active')
              .executeTakeFirst();
            if (membership) return true;
            const link = await trx
              .selectFrom('person_account_links')
              .select('id')
              .where('org_id', '=', orgId)
              .where('account_id', '=', session.accountId)
              .where('revoked_at', 'is', null)
              .executeTakeFirst();
            return Boolean(link);
          },
        );
        if (!allowed) throw new FinanceAccessError();
        const templates = await new PostgresInstallmentTemplates(
          dependencies.database,
          context,
        ).list(true);
        response.json(installmentTemplateListSchema.parse({ templates }));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/installment-templates',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const context = { orgId, actor: { accountId: session.accountId } };
        await requireFinanceStaff(dependencies.database, context);
        const body = installmentTemplateBodySchema.parse(
          request.body as unknown,
        );
        const template = await new PostgresInstallmentTemplates(
          dependencies.database,
          context,
        ).create(body);
        response.status(201).json(installmentTemplateSchema.parse(template));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.patch(
    '/orgs/:orgId/installment-templates/:templateId',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const context = { orgId, actor: { accountId: session.accountId } };
        await requireFinanceStaff(dependencies.database, context);
        const templateId = z.uuid().parse(request.params.templateId);
        const version = z.coerce
          .number()
          .int()
          .positive()
          .parse(request.get('If-Match'));
        const body = installmentTemplateBodySchema.parse(
          request.body as unknown,
        );
        const template = await new PostgresInstallmentTemplates(
          dependencies.database,
          context,
        ).replace(templateId, version, body);
        response.json(installmentTemplateSchema.parse(template));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.delete(
    '/orgs/:orgId/installment-templates/:templateId',
    async (request, response) => {
      try {
        if (
          !writeOriginValid(request, dependencies.appUrl) ||
          requestImpersonation(request)
        )
          throw new FinanceAccessError();
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const context = { orgId, actor: { accountId: session.accountId } };
        await requireFinanceStaff(dependencies.database, context);
        const templateId = z.uuid().parse(request.params.templateId);
        const version = z.coerce
          .number()
          .int()
          .positive()
          .parse(request.get('If-Match'));
        await new PostgresInstallmentTemplates(
          dependencies.database,
          context,
        ).archive(templateId, version);
        response.json(
          paymentMethodActionResponseSchema.parse({ success: true }),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
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
      const storedDefault = await new PostgresSavedPaymentMethodRepository(
        dependencies.database,
      ).loadDefault(session.accountId);
      response.json(
        savedPaymentMethodsResponseSchema.parse({
          methods,
          defaultMethodId: methods.some((method) => method.id === storedDefault)
            ? storedDefault
            : null,
        }),
      );
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
