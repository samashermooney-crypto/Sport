import type { ServerModule } from '../../lib/module-contract';

import { createOrgRouter } from './routes';

export const moduleDefinition = {
  name: 'orgs',
  path: '/api/v1/orgs',
  router: createOrgRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
} satisfies ServerModule;
