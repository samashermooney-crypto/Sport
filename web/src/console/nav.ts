import type { NavItem } from '../api/features';

import { classesConsoleNav } from './classes/nav';
import { consoleEvaluationNav } from './evaluations/nav';
import { federationConsoleNav } from './federation/nav';
import { consoleReportsNav } from './reports/nav';
import { scheduleConsoleNav } from './schedule/nav';
import { consoleWebsiteNav } from './website/nav';

export const consoleNav: readonly NavItem[] = [
  ...scheduleConsoleNav,
  ...classesConsoleNav,
  ...consoleEvaluationNav,
  ...consoleReportsNav,
  ...consoleWebsiteNav,
  ...federationConsoleNav,
];
