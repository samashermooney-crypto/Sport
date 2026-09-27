import type { ServerModule } from '../../lib/module-contract';

import type { RegisteredJob } from './registry';

const jobs = [
  {
    name: 'jobs.probe',
    run: () => Promise.resolve({ healthy: true }),
  },
] satisfies RegisteredJob[];

export const moduleDefinition = {
  name: 'jobs',
  path: '/api/v1/jobs',
  jobs,
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
} satisfies ServerModule;
