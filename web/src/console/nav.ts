import type { NavItem } from '../api/features';

import { classesConsoleNav } from './classes/nav';
import { federationConsoleNav } from './federation/nav';
import { scheduleConsoleNav } from './schedule/nav';

export const consoleNav: readonly NavItem[] = [
  ...scheduleConsoleNav,
  ...classesConsoleNav,
  ...federationConsoleNav,
];
