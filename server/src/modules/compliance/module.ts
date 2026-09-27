import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createComplianceRouter } from './routes';

const configSchema = z
  .object({
    CHECKR_ENABLED: z.enum(['true', 'false']).optional(),
    CHECKR_API_KEY: z.string().optional(),
    CHECKR_BASE_URL: z.string().optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  })
  .superRefine((value, context) => {
    if (value.CHECKR_ENABLED === 'true' && !value.CHECKR_API_KEY)
      context.addIssue({
        code: 'custom',
        path: ['CHECKR_API_KEY'],
        message: 'Checkr requires a server-side API key',
      });
    if (
      value.NODE_ENV !== 'production' &&
      value.CHECKR_BASE_URL === 'https://api.checkr.com'
    )
      context.addIssue({
        code: 'custom',
        path: ['CHECKR_BASE_URL'],
        message: 'Local and test environments must use Checkr staging',
      });
  });

export const moduleDefinition = {
  name: 'compliance',
  path: '/api/v1/compliance',
  router: createComplianceRouter,
  jobs: [{ name: 'credentials.expiry' }],
  permissions: [],
  notificationTypes: [
    'compliance.credential_expired',
    'compliance.credential_expiry_reminder',
    'compliance.credential_rejected',
    'compliance.credential_revoked',
    'compliance.credential_verified',
    'compliance.role_activated',
    'compliance.role_demoted',
    'compliance.background_check_adverse_notice',
  ],
  errorCodes: [],
  configSchema,
} satisfies ServerModule;
