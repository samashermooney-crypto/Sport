import type { ServerModule } from '../../lib/module-contract.js';

import {
  createFinanceRouter,
  offlinePaymentBodySchema,
  offlinePaymentReceiptSchema,
  refundBodySchema,
  refundResponseSchema,
  refundApprovalResponseSchema,
  refundApprovalDecisionSchema,
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
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
