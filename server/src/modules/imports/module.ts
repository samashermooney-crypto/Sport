import type { ServerModule } from '../../lib/module-contract';

import { runPhase15ImportJob } from './phase15-jobs';
import { phase15ImportOpenApiRoutes } from './phase15-openapi';
import { createPhase15ImportsRouter } from './phase15-routes';
import { createImportsRouter } from './routes';

export const moduleDefinition = {
  name: 'imports',
  path: '/api/v1/imports',
  router: createImportsRouter,
  extraRouters: [
    { path: '/api/v1/imports', router: createPhase15ImportsRouter },
  ],
  jobs: [{ name: 'imports.process', run: runPhase15ImportJob }],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: phase15ImportOpenApiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
