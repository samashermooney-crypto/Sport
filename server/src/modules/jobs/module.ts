import type { ServerModule } from '../../lib/module-contract';
import type { AuthDependencies } from '../auth/routes';

import { createOperationalHealthRouter } from './health-routes';
import { runOperationalAlertCheck } from './operational-alerts';
import type { RegisteredJob } from './registry';

const jobs = [
  {
    name: 'jobs.probe',
    run: () => Promise.resolve({ healthy: true }),
  },
  {
    name: 'ops.alert-check',
    run: () => runOperationalAlertCheck(),
    cron: '* * * * *',
  },
] satisfies RegisteredJob[];

export const moduleDefinition = {
  name: 'jobs',
  path: '/api/v1/jobs',
  publicRouter: (dependencies: AuthDependencies) =>
    createOperationalHealthRouter(dependencies.database),
  jobs,
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
} satisfies ServerModule;
