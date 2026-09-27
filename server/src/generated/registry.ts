import type { IntegrationConfig, ServerModule } from '../lib/module-contract';
import { moduleDefinition as authModule } from '../modules/auth/module';
import { moduleDefinition as orgsModule } from '../modules/orgs/module';

export const serverModules: readonly ServerModule[] = [authModule, orgsModule];
export const integrationConfigs: readonly IntegrationConfig[] = [];
