import type { RouteObject } from 'react-router';

import { consoleAuditRoutes } from '../console/audit/routes';
import { consoleFundraisingRoutes } from '../console/fundraising/routes';
import { consoleMessagesRoutes } from '../console/messages/routes';
import { consoleMoneyRoutes } from '../console/money/routes';
import { consoleSafetyRoutes } from '../console/safety/routes';
import { consoleScheduleRoutes } from '../console/schedule/routes';
import { consoleSponsorsRoutes } from '../console/sponsors/routes';
import { consoleStoreRoutes } from '../console/store/routes';
import { consoleTeamFinanceRoutes } from '../console/teamFinance/routes';
import { consoleVolunteersRoutes } from '../console/volunteers/routes';
import { portalMessagesRoutes } from '../portal/messages/routes';
import { portalMoneyRoutes } from '../portal/money/routes';
import { portalNotificationsRoutes } from '../portal/notifications/routes';
import { portalSafetyRoutes } from '../portal/safety/routes';
import { portalScheduleRoutes } from '../portal/schedule/routes';
import { portalStoreRoutes } from '../portal/store/routes';
import { portalTeamFinanceRoutes } from '../portal/teamFinance/routes';
import { portalVolunteersRoutes } from '../portal/volunteers/routes';
import { siteFundraisingRoutes } from '../site/fundraising/routes';

export const webNestedRoutes: readonly RouteObject[] = [
  consoleAuditRoutes,
  consoleFundraisingRoutes,
  consoleMessagesRoutes,
  consoleMoneyRoutes,
  consoleSafetyRoutes,
  consoleScheduleRoutes,
  consoleSponsorsRoutes,
  consoleStoreRoutes,
  consoleTeamFinanceRoutes,
  consoleVolunteersRoutes,
  portalMessagesRoutes,
  portalMoneyRoutes,
  portalNotificationsRoutes,
  portalSafetyRoutes,
  portalScheduleRoutes,
  portalStoreRoutes,
  portalTeamFinanceRoutes,
  portalVolunteersRoutes,
  siteFundraisingRoutes,
].flat();
