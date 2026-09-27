import type { ServerModule } from '../../lib/module-contract';

import { createFilesRouter } from './routes';

export const moduleDefinition = {
  name: 'files',
  path: '/api/v1/files',
  permissions: [],
  errorCodes: [],
} satisfies ServerModule;

export { createFilesRouter };
