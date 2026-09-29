import type { NavItem } from '../../api/features';

export const portalHelpNav: readonly NavItem[] = [
  {
    area: 'portal',
    group: 'Account',
    order: 90,
    label: 'Help',
    path: '/portal/orgs/:orgId/help',
  },
];
