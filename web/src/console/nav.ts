import type { NavItem } from '../api/features';

import { scheduleConsoleNav } from './schedule/nav';

export const consoleNav: readonly NavItem[] = [...scheduleConsoleNav];
