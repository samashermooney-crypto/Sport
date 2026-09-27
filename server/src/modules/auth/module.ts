import type { ServerModule } from '../../lib/module-contract';

import { createAuthRouter } from './routes';

export const moduleDefinition = {
  name: 'auth',
  path: '/api/v1/auth',
  router: createAuthRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
} satisfies ServerModule;
