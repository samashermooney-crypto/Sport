import type { IntegrationConfig, ServerModule } from '../lib/module-contract';
import { moduleDefinition as authModule } from '../modules/auth/module';
import { moduleDefinition as jobsModule } from '../modules/jobs/module';
import { moduleDefinition as orgsModule } from '../modules/orgs/module';

export const serverModules: readonly ServerModule[] = [
  authModule,
  jobsModule,
  orgsModule,
];
export const integrationConfigs: readonly IntegrationConfig[] = [];
