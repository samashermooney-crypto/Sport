import type { NavItem } from '../../api/features';

export const schedulePortalNav: readonly NavItem[] = [
  {
    area: 'portal',
    group: 'Family',
    order: 20,
    label: 'Schedule',
    path: '/portal/orgs/:orgId/schedule/teams/:teamSeasonId/people/:personId',
  },
];
