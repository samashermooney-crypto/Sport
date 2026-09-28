import type { NavItem } from '../../api/features';

export const consoleEvaluationNav: readonly NavItem[] = [
  {
    area: 'console',
    group: 'Programs',
    order: 40,
    label: 'Evaluations',
    path: '/console/orgs/:orgId/evaluations',
    requiredPermission: 'evaluations.manage',
  },
];
