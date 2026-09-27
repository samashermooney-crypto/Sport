import type { Router } from 'express';
import type { z } from 'zod';

import type { AuthDependencies } from '../modules/auth/routes';

export interface ServerModule {
  name: string;
  path: `/api/v1/${string}`;
  router?: (dependencies: AuthDependencies) => Router;
  jobs?: readonly {
    name: string;
    run?: (data: unknown) => Promise<unknown>;
    cron?: string;
  }[];
  permissions?: readonly string[];
  notificationTypes?: readonly string[];
  errorCodes?: readonly string[];
  configSchema?: z.ZodType;
}

export interface IntegrationConfig {
  name: string;
  schema: z.ZodType;
}
