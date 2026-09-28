import type { NavItem } from '../../api/features';

export const portalEvaluationNav: readonly NavItem[] = [
  {
    area: 'portal',
    group: 'Programs',
    order: 45,
    label: 'Team offers',
    path: '/portal/orgs/:orgId/offers',
  },
  {
    area: 'portal',
    group: 'Programs',
    order: 46,
    label: 'Evaluation results',
    path: '/portal/orgs/:orgId/results',
  },
  {
    area: 'portal',
    group: 'Programs',
    order: 47,
    label: 'Placement preferences',
    path: '/portal/orgs/:orgId/placement-preferences',
  },
];
