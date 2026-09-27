import type { WebFeature } from '../api/features';
import { authNav } from '../auth/nav';
import { authRoutes } from '../auth/routes';
import { platformNav } from '../platform/nav';
import { platformRoutes } from '../platform/routes';
import { uiNav } from '../ui/nav';
import { uiRoutes } from '../ui/routes';

export const webFeatures: readonly WebFeature[] = [
  { name: 'auth', routes: authRoutes, nav: authNav },
  { name: 'platform', routes: platformRoutes, nav: platformNav },
  { name: 'ui', routes: uiRoutes, nav: uiNav },
];
