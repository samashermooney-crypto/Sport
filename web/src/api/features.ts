import type { RouteObject } from 'react-router';

export interface NavItem {
  area: 'console' | 'portal' | 'platform' | 'public';
  group: string;
  order: number;
  label: string;
  path: string;
  requiredPermission?: string;
}

export interface WebFeature {
  name: string;
  routes: readonly RouteObject[];
  nav: readonly NavItem[];
}
