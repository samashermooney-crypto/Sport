import type { ServerModule } from '../../lib/module-contract';

import { createActionCenterRouter } from './routes';
import { actionCenterResponseSchema } from './schema';

export const moduleDefinition = {
  name: 'action-center',
  path: '/api/v1/action-center',
  router: createActionCenterRouter,
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/action-center/orgs/{orgId}/action-center',
      summary: 'List tenant-scoped operational queues visible to the current role',
      response: actionCenterResponseSchema,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
