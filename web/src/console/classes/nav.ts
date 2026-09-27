import type { NavItem } from '../../api/features';

export const classesConsoleNav: readonly NavItem[] = [
  {
    area: 'console',
    group: 'Programs',
    order: 90,
    label: 'Classes',
    path: '/console/orgs/:orgId/classes',
    requiredPermission: 'classes.manage',
  },
];
