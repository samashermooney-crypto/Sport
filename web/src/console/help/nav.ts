import type { NavItem } from '../../api/features';

import { aiFeaturesEnabled } from './ai-enabled';

export const helpNav: readonly NavItem[] = [
  {
    area: 'console',
    group: 'Help',
    order: 1,
    label: 'Help center',
    path: '/console/orgs/:orgId/help',
  },
  ...(aiFeaturesEnabled
    ? [
        {
          area: 'console' as const,
          group: 'Help',
          order: 2,
          label: 'AI assistance',
          path: '/console/orgs/:orgId/ai',
        },
      ]
    : []),
];
