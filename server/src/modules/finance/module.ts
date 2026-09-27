import type { ServerModule } from '../../lib/module-contract.js';

import {
  createFinanceRouter,
  offlinePaymentBodySchema,
  offlinePaymentReceiptSchema,
  refundBodySchema,
  refundResponseSchema,
  refundApprovalResponseSchema,
  refundApprovalDecisionSchema,
  payoutJournalBodySchema,
  payoutJournalResponseSchema,
  setupIntentResponseSchema,
  savedPaymentMethodsResponseSchema,
  paymentMethodActionResponseSchema,
} from './routes.js';

export const moduleDefinition = {
  name: 'finance',
  path: '/api/v1/finance',
  router: createFinanceRouter,
  jobs: [],
  permissions: ['finance.manage'],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'post',
      path: '/api/v1/finance/me/setup-intents',
      summary: 'Create a test-mode SetupIntent for the signed-in payer',
      response: setupIntentResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/me/payment-methods',
      summary: 'List saved payment methods for the signed-in payer',
      response: savedPaymentMethodsResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/me/payment-methods/{paymentMethodId}/default',
      summary: 'Set the signed-in payer default payment method',
      response: paymentMethodActionResponseSchema,
    },
    {
      method: 'delete',
      path: '/api/v1/finance/me/payment-methods/{paymentMethodId}',
      summary: 'Detach a saved payment method and revoke its autopay mandates',
      response: paymentMethodActionResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/offline-payments',
      summary: 'Record an offline invoice payment',
      body: offlinePaymentBodySchema,
      response: offlinePaymentReceiptSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/refunds',
      summary: 'Create a policy-based refund to original method or credit',
      body: refundBodySchema,
      response: refundResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/refund-approvals',
      summary: 'Request a second finance approval for a refund',
      body: refundBodySchema,
      response: refundApprovalResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/refund-approvals/{approvalId}/approve',
      summary: 'Approve a refund with a separate stepped-up finance session',
      response: refundApprovalDecisionSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/payouts/{payoutId}/journal-export',
      summary: 'Export a reconciled payout journal with explicit GL codes',
      body: payoutJournalBodySchema,
      response: payoutJournalResponseSchema,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
