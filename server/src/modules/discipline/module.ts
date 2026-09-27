import type { ServerModule } from '../../lib/module-contract';

import { createDisciplineRouter } from './routes';

export const moduleDefinition = {
  name: 'discipline',
  path: '/api/v1/discipline',
  router: createDisciplineRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
} satisfies ServerModule;
