import type { NavItem } from '../api/features';

import { classesPortalNav } from './classes/nav';
import { portalEvaluationNav } from './evaluations/nav';
import { portalHelpNav } from './help/nav';
import { schedulePortalNav } from './schedule/nav';

export const portalNav: readonly NavItem[] = [
  ...schedulePortalNav,
  ...classesPortalNav,
  ...portalEvaluationNav,
  ...portalHelpNav,
];
