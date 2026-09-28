import type { RouteObject } from 'react-router';

import { consoleAuditRoutes } from '../console/audit/routes';
import { consoleClassesRoutes } from '../console/classes/routes';
import { consoleEvaluationsRoutes } from '../console/evaluations/routes';
import { consoleFacilitiesRoutes } from '../console/facilities/routes';
import { consoleFederationRoutes } from '../console/federation/routes';
import { consoleFundraisingRoutes } from '../console/fundraising/routes';
import { consoleHomeRoutes } from '../console/home/routes';
import { consoleMessagesRoutes } from '../console/messages/routes';
import { consoleMoneyRoutes } from '../console/money/routes';
import { consoleProgramsRoutes } from '../console/programs/routes';
import { consoleRegistrationRoutes } from '../console/registration/routes';
import { consoleReportsRoutes } from '../console/reports/routes';
import { consoleSafetyRoutes } from '../console/safety/routes';
import { consoleScheduleRoutes } from '../console/schedule/routes';
import { consoleSponsorsRoutes } from '../console/sponsors/routes';
import { consoleStoreRoutes } from '../console/store/routes';
import { consoleTeamFinanceRoutes } from '../console/teamFinance/routes';
import { consoleTeamsRoutes } from '../console/teams/routes';
import { consoleVolunteersRoutes } from '../console/volunteers/routes';
import { consoleWebsiteRoutes } from '../console/website/routes';
import { portalClassesRoutes } from '../portal/classes/routes';
import { portalEvaluationsRoutes } from '../portal/evaluations/routes';
import { portalMessagesRoutes } from '../portal/messages/routes';
import { portalMoneyRoutes } from '../portal/money/routes';
import { portalNotificationsRoutes } from '../portal/notifications/routes';
import { portalRegistrationRoutes } from '../portal/registration/routes';
import { portalSafetyRoutes } from '../portal/safety/routes';
import { portalScheduleRoutes } from '../portal/schedule/routes';
import { portalStoreRoutes } from '../portal/store/routes';
import { portalTeamFinanceRoutes } from '../portal/teamFinance/routes';
import { portalVolunteersRoutes } from '../portal/volunteers/routes';
import { siteFundraisingRoutes } from '../site/fundraising/routes';
import { siteSponsorsRoutes } from '../site/sponsors/routes';

export const webNestedRoutes: readonly RouteObject[] = [
  consoleAuditRoutes,
  consoleClassesRoutes,
  consoleEvaluationsRoutes,
  consoleFacilitiesRoutes,
  consoleFederationRoutes,
  consoleFundraisingRoutes,
  consoleHomeRoutes,
  consoleMessagesRoutes,
  consoleMoneyRoutes,
  consoleProgramsRoutes,
  consoleRegistrationRoutes,
  consoleReportsRoutes,
  consoleSafetyRoutes,
  consoleScheduleRoutes,
  consoleSponsorsRoutes,
  consoleStoreRoutes,
  consoleTeamFinanceRoutes,
  consoleTeamsRoutes,
  consoleVolunteersRoutes,
  consoleWebsiteRoutes,
  portalClassesRoutes,
  portalEvaluationsRoutes,
  portalMessagesRoutes,
  portalMoneyRoutes,
  portalNotificationsRoutes,
  portalRegistrationRoutes,
  portalSafetyRoutes,
  portalScheduleRoutes,
  portalStoreRoutes,
  portalTeamFinanceRoutes,
  portalVolunteersRoutes,
  siteFundraisingRoutes,
  siteSponsorsRoutes,
].flat();
