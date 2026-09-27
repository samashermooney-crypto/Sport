import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';

import { Landing } from '../marketing/Landing';
import { LegalPage } from '../marketing/LegalPage';
import { PricingPage } from '../marketing/PricingPage';

const DevShowcase = import.meta.env.DEV
  ? lazy(() =>
      import('./dev/Showcase').then(({ Showcase }) => ({
        default: Showcase,
      })),
    )
  : null;

export const uiRoutes: readonly RouteObject[] = [
  { path: '/welcome', element: <Landing /> },
  { path: '/pricing', element: <PricingPage /> },
  { path: '/legal/:slug', element: <LegalPage /> },
  ...(DevShowcase
    ? [
        {
          path: '/__ui',
          element: (
            <Suspense
              fallback={<div role="status">Loading design system…</div>}
            >
              <DevShowcase />
            </Suspense>
          ),
        },
      ]
    : []),
];
