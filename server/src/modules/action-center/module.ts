import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createActionCenterRouter } from './routes';
import {
  actionCenterMutationResponseSchema,
  actionCenterResponseSchema,
} from './schema';

export const moduleDefinition = {
  name: 'action-center',
  path: '/api/v1/action-center',
  router: createActionCenterRouter,
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/action-center/orgs/{orgId}/action-center',
      summary:
        'List tenant-scoped operational queues visible to the current role',
      response: actionCenterResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/action-center/orgs/{orgId}/action-center/actions/past-due-reminders',
      summary:
        'Send unread-safe in-app reminders for eligible overdue invoices',
      body: z.strictObject({}),
      response: actionCenterMutationResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/action-center/orgs/{orgId}/action-center/actions/failed-installment-contacts',
      summary:
        'Notify families about recent failed autopay installments without retrying a charge',
      body: z.strictObject({}),
      response: actionCenterMutationResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/action-center/orgs/{orgId}/action-center/actions/staff-compliance-reminders',
      summary:
        'Notify verified staff accounts that compliance requirements need attention',
      body: z.strictObject({}),
      response: actionCenterMutationResponseSchema,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
