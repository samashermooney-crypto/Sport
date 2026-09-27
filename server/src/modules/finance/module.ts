import type { ServerModule } from '../../lib/module-contract.js';

import {
  createFinanceRouter,
  offlinePaymentBodySchema,
  offlinePaymentReceiptSchema,
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
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
