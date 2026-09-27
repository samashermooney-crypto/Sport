import type { NavItem } from '../../api/features';

export const scheduleConsoleNav: readonly NavItem[] = [
  {
    area: 'console',
    group: 'Operations',
    order: 30,
    label: 'Schedule',
    path: '/console/orgs/:orgId/schedule',
    requiredPermission: 'schedule.read',
  },
];
