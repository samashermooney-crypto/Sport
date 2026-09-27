import type { NavItem } from '../api/features';

import { schedulePortalNav } from './schedule/nav';

export const portalNav: readonly NavItem[] = [...schedulePortalNav];
