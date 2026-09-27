import type { WebFeature } from '../api/features';
import { authNav } from '../auth/nav';
import { authRoutes } from '../auth/routes';
import { orgsNav } from '../orgs/nav';
import { orgsRoutes } from '../orgs/routes';
import { uiNav } from '../ui/nav';
import { uiRoutes } from '../ui/routes';

export const webFeatures: readonly WebFeature[] = [
  { name: 'auth', routes: authRoutes, nav: authNav },
  { name: 'orgs', routes: orgsRoutes, nav: orgsNav },
  { name: 'ui', routes: uiRoutes, nav: uiNav },
];
