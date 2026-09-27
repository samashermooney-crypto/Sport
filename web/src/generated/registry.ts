import type { WebFeature } from '../api/features';
import { authNav } from '../auth/nav';
import { authRoutes } from '../auth/routes';

export const webFeatures: readonly WebFeature[] = [
  { name: 'auth', routes: authRoutes, nav: authNav },
];
