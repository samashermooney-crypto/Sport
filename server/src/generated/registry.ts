import { integrationConfig as backgroundCheckConfig } from '../integrations/background-check/config';
import { integrationConfig as emailConfig } from '../integrations/email/config';
import { integrationConfig as geocoderConfig } from '../integrations/geocoder/config';
import { integrationConfig as pushConfig } from '../integrations/push/config';
import { integrationConfig as smsConfig } from '../integrations/sms/config';
import { integrationConfig as storageConfig } from '../integrations/storage/config';
import type { IntegrationConfig, ServerModule } from '../lib/module-contract';
import { moduleDefinition as auditModule } from '../modules/audit/module';
import { moduleDefinition as authModule } from '../modules/auth/module';
import { moduleDefinition as communicationsModule } from '../modules/communications/module';
import { moduleDefinition as complianceModule } from '../modules/compliance/module';
import { moduleDefinition as disciplineModule } from '../modules/discipline/module';
import { moduleDefinition as filesModule } from '../modules/files/module';
import { moduleDefinition as financeModule } from '../modules/finance/module';
import { moduleDefinition as fundraisingModule } from '../modules/fundraising/module';
import { moduleDefinition as jobsModule } from '../modules/jobs/module';
import { moduleDefinition as notificationsModule } from '../modules/notifications/module';
import { moduleDefinition as orgsModule } from '../modules/orgs/module';
import { moduleDefinition as peopleModule } from '../modules/people/module';
import { moduleDefinition as platformModule } from '../modules/platform/module';
import { moduleDefinition as safetyModule } from '../modules/safety/module';
import { moduleDefinition as sponsorsModule } from '../modules/sponsors/module';
import { moduleDefinition as storeModule } from '../modules/store/module';
import { moduleDefinition as teamFinanceModule } from '../modules/team-finance/module';
import { moduleDefinition as volunteersModule } from '../modules/volunteers/module';

export const serverModules: readonly ServerModule[] = [
  auditModule,
  authModule,
  communicationsModule,
  complianceModule,
  disciplineModule,
  filesModule,
  financeModule,
  fundraisingModule,
  jobsModule,
  notificationsModule,
  orgsModule,
  peopleModule,
  platformModule,
  safetyModule,
  sponsorsModule,
  storeModule,
  teamFinanceModule,
  volunteersModule,
];
export const integrationConfigs: readonly IntegrationConfig[] = [
  backgroundCheckConfig,
  emailConfig,
  geocoderConfig,
  pushConfig,
  smsConfig,
  storageConfig,
];
