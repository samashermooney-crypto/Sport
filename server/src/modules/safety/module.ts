import type { ServerModule } from '../../lib/module-contract';

import { createSafetyRouter } from './routes';

export const moduleDefinition = {
  name: 'safety',
  path: '/api/v1/safety',
  router: createSafetyRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [
    'safety.injury_reported',
    'safety.incident_reported',
    'safety.safesport_concern_reported',
  ],
  errorCodes: [],
} satisfies ServerModule;
