import type { Router } from 'express';
import type { Kysely } from 'kysely';
import type { z } from 'zod';

import type { DB } from '../db/types';
import type { withOrg } from '../db/withOrg';
import type { Storage } from '../integrations/storage/storage';
import type { AuthDependencies } from '../modules/auth/routes';
import type { SeasonRolloverExtras } from '../modules/seasons/service';

export type ServerModuleRouterDependencies = AuthDependencies & {
  seasonRolloverExtras?: SeasonRolloverExtras[];
  storage?: Storage;
};

export interface JobRuntimeDependencies {
  database: Kysely<DB>;
  storage: Storage;
  now: Date;
  runWithOrg: typeof withOrg;
}

export interface ServerModule {
  name: string;
  path: `/api/v1/${string}`;
  router?: (dependencies: ServerModuleRouterDependencies) => Router;
  publicRouter?: (dependencies: AuthDependencies) => Router;
  extraRouters?: readonly {
    path: `/${string}`;
    router: (dependencies: AuthDependencies) => Router;
  }[];
  seasonRolloverExtras?: readonly SeasonRolloverExtras[];
  jobs?: readonly {
    name: string;
    run?: (
      data: unknown,
      dependencies: JobRuntimeDependencies,
    ) => Promise<unknown>;
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
