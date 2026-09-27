import type { NavItem } from '../../api/features';

export const classesPortalNav: readonly NavItem[] = [
  {
    area: 'portal',
    group: 'Family',
    order: 35,
    label: 'Classes',
    path: '/me/orgs/:orgId/classes',
  },
];
