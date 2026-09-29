import type { WebFeature } from '../api/features';
import { authNav } from '../auth/nav';
import { authRoutes } from '../auth/routes';
import { consoleNav } from '../console/nav';
import { consoleRoutes } from '../console/routes';
import { marketingNav } from '../marketing/nav';
import { marketingRoutes } from '../marketing/routes';
import { orgsNav } from '../orgs/nav';
import { orgsRoutes } from '../orgs/routes';
import { peopleNav } from '../people/nav';
import { peopleRoutes } from '../people/routes';
import { platformNav } from '../platform/nav';
import { platformRoutes } from '../platform/routes';
import { portalNav } from '../portal/nav';
import { portalRoutes } from '../portal/routes';
import { siteNav } from '../site/nav';
import { siteRoutes } from '../site/routes';
import { uiNav } from '../ui/nav';
import { uiRoutes } from '../ui/routes';

export const webFeatures: readonly WebFeature[] = [
  { name: 'auth', routes: authRoutes, nav: authNav },
  { name: 'console', routes: consoleRoutes, nav: consoleNav },
  { name: 'marketing', routes: marketingRoutes, nav: marketingNav },
  { name: 'orgs', routes: orgsRoutes, nav: orgsNav },
  { name: 'people', routes: peopleRoutes, nav: peopleNav },
  { name: 'platform', routes: platformRoutes, nav: platformNav },
  { name: 'portal', routes: portalRoutes, nav: portalNav },
  { name: 'site', routes: siteRoutes, nav: siteNav },
  { name: 'ui', routes: uiRoutes, nav: uiNav },
];
