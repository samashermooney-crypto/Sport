import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';

import { RouteLoading } from '../ui/RouteLoading';

const Landing = lazy(() =>
  import('./Landing').then(({ Landing: Component }) => ({
    default: Component,
  })),
);
const LegalPage = lazy(() =>
  import('./LegalPage').then(({ LegalPage: Component }) => ({
    default: Component,
  })),
);
const PricingPage = lazy(() =>
  import('./PricingPage').then(({ PricingPage: Component }) => ({
    default: Component,
  })),
);

function loading(element: React.ReactNode): React.JSX.Element {
  return <Suspense fallback={<RouteLoading />}>{element}</Suspense>;
}

export const marketingRoutes: readonly RouteObject[] = [
  { path: '/welcome', element: loading(<Landing />) },
  { path: '/pricing', element: loading(<PricingPage />) },
  { path: '/legal/:slug', element: loading(<LegalPage />) },
];
