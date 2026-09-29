import { integrationConfig as backgroundCheckConfig } from '../integrations/background-check/config';
import { integrationConfig as emailConfig } from '../integrations/email/config';
import { integrationConfig as geocoderConfig } from '../integrations/geocoder/config';
import { integrationConfig as pushConfig } from '../integrations/push/config';
import { integrationConfig as smsConfig } from '../integrations/sms/config';
import { integrationConfig as storageConfig } from '../integrations/storage/config';
import type { IntegrationConfig, ServerModule } from '../lib/module-contract';
import { moduleDefinition as actionCenterModule } from '../modules/action-center/module';
import { moduleDefinition as aiModule } from '../modules/ai/module';
import { moduleDefinition as attendanceModule } from '../modules/attendance/module';
import { moduleDefinition as auditModule } from '../modules/audit/module';
import { moduleDefinition as authModule } from '../modules/auth/module';
import { moduleDefinition as classesModule } from '../modules/classes/module';
import { moduleDefinition as communicationsModule } from '../modules/communications/module';
import { moduleDefinition as complianceModule } from '../modules/compliance/module';
import { moduleDefinition as contestsModule } from '../modules/contests/module';
import { moduleDefinition as disciplineModule } from '../modules/discipline/module';
import { moduleDefinition as evaluationsModule } from '../modules/evaluations/module';
import { moduleDefinition as exportsModule } from '../modules/exports/module';
import { moduleDefinition as facilitiesModule } from '../modules/facilities/module';
import { moduleDefinition as federationModule } from '../modules/federation/module';
import { moduleDefinition as filesModule } from '../modules/files/module';
import { moduleDefinition as financeModule } from '../modules/finance/module';
import { moduleDefinition as formsModule } from '../modules/forms/module';
import { moduleDefinition as fundraisingModule } from '../modules/fundraising/module';
import { moduleDefinition as helpModule } from '../modules/help/module';
import { moduleDefinition as importsModule } from '../modules/imports/module';
import { moduleDefinition as jobsModule } from '../modules/jobs/module';
import { moduleDefinition as notificationsModule } from '../modules/notifications/module';
import { moduleDefinition as offeringsModule } from '../modules/offerings/module';
import { moduleDefinition as officialsModule } from '../modules/officials/module';
import { moduleDefinition as onboardingModule } from '../modules/onboarding/module';
import { moduleDefinition as orgsModule } from '../modules/orgs/module';
import { moduleDefinition as peopleModule } from '../modules/people/module';
import { moduleDefinition as platformModule } from '../modules/platform/module';
import { moduleDefinition as programsModule } from '../modules/programs/module';
import { moduleDefinition as registrationModule } from '../modules/registration/module';
import { moduleDefinition as reportsModule } from '../modules/reports/module';
import { moduleDefinition as rostersModule } from '../modules/rosters/module';
import { moduleDefinition as safetyModule } from '../modules/safety/module';
import { moduleDefinition as schedulingModule } from '../modules/scheduling/module';
import { moduleDefinition as seasonsModule } from '../modules/seasons/module';
import { moduleDefinition as sponsorsModule } from '../modules/sponsors/module';
import { moduleDefinition as sportsModule } from '../modules/sports/module';
import { moduleDefinition as standingsModule } from '../modules/standings/module';
import { moduleDefinition as storeModule } from '../modules/store/module';
import { moduleDefinition as teamFinanceModule } from '../modules/team-finance/module';
import { moduleDefinition as teamsModule } from '../modules/teams/module';
import { moduleDefinition as tournamentsModule } from '../modules/tournaments/module';
import { moduleDefinition as volunteersModule } from '../modules/volunteers/module';
import { moduleDefinition as waiversModule } from '../modules/waivers/module';
import { moduleDefinition as websiteModule } from '../modules/website/module';

export const serverModules: readonly ServerModule[] = [
  actionCenterModule,
  aiModule,
  attendanceModule,
  auditModule,
  authModule,
  classesModule,
  communicationsModule,
  complianceModule,
  contestsModule,
  disciplineModule,
  evaluationsModule,
  exportsModule,
  facilitiesModule,
  federationModule,
  filesModule,
  financeModule,
  formsModule,
  fundraisingModule,
  helpModule,
  importsModule,
  jobsModule,
  notificationsModule,
  offeringsModule,
  officialsModule,
  onboardingModule,
  orgsModule,
  peopleModule,
  platformModule,
  programsModule,
  registrationModule,
  reportsModule,
  rostersModule,
  safetyModule,
  schedulingModule,
  seasonsModule,
  sponsorsModule,
  sportsModule,
  standingsModule,
  storeModule,
  teamFinanceModule,
  teamsModule,
  tournamentsModule,
  volunteersModule,
  waiversModule,
  websiteModule,
];
export const integrationConfigs: readonly IntegrationConfig[] = [
  backgroundCheckConfig,
  emailConfig,
  geocoderConfig,
  pushConfig,
  smsConfig,
  storageConfig,
];
export { apiRouteMetadata } from './api-route-metadata';
