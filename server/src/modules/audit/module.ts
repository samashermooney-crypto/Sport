import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createAuditRouter } from './routes';
import { auditPageSchema } from './schema';

export const moduleDefinition = {
  name: 'audit',
  path: '/api/v1/audit',
  router: createAuditRouter,
  jobs: [],
  permissions: ['audit.read'],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/audit/orgs/{orgId}',
      summary: 'List organization audit history',
      response: auditPageSchema,
      query: {
        limit: z.string().optional(),
        cursor: z.string().optional(),
        entityType: z.string().optional(),
        entityId: z.uuid().optional(),
        restrictedOnly: z.enum(['true', 'false']).optional(),
      },
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
