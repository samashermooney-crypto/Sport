import { getDatabase } from '../../db/kysely';
import type { ServerModule } from '../../lib/module-contract';

import { expireStaleDevices } from './devices';
import { clearExpiredAuthRateLimits } from './rate-limits';
import { createAuthRouter } from './routes';

export const moduleDefinition = {
  name: 'auth',
  path: '/api/v1/auth',
  router: createAuthRouter,
  jobs: [
    {
      name: 'auth.devices.expire',
      cron: '0 * * * *',
      run: () => expireStaleDevices(getDatabase(), new Date()),
    },
    {
      name: 'auth.rate-limits.expire',
      cron: '15 * * * *',
      run: () => clearExpiredAuthRateLimits(getDatabase()),
    },
  ],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
} satisfies ServerModule;
