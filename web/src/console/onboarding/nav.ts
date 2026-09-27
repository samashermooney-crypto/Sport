import type { NavItem } from '../../api/features';

export const onboardingNav: readonly NavItem[] = [
  {
    area: 'console',
    group: 'People',
    order: 30,
    label: 'Imports',
    path: '/console/orgs/:orgId/onboarding/imports',
  },
  {
    area: 'console',
    group: 'Settings',
    order: 90,
    label: 'Organization setup',
    path: '/console/orgs/:orgId/onboarding',
  },
];
