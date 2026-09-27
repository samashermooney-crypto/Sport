import type { IntegrationConfig, ServerModule } from '../lib/module-contract';
import { moduleDefinition as authModule } from '../modules/auth/module';

export const serverModules: readonly ServerModule[] = [authModule];
export const integrationConfigs: readonly IntegrationConfig[] = [];
