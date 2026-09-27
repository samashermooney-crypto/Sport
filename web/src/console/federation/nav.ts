import type { NavItem } from '../../api/features';

export const federationConsoleNav: readonly NavItem[] = [
  {
    area: 'console',
    group: 'Manage',
    order: 90,
    label: 'Federation',
    path: '/console/federation/:orgId',
    requiredPermission: 'federation.read',
  },
];
