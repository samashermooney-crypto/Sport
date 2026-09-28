import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';

const DevShowcase = import.meta.env.DEV
  ? lazy(() =>
      import('./dev/Showcase').then(({ Showcase }) => ({
        default: Showcase,
      })),
    )
  : null;

export const uiRoutes: readonly RouteObject[] = DevShowcase
  ? [
      {
        path: '/__ui',
        element: (
          <Suspense fallback={<div role="status">Loading design system…</div>}>
            <DevShowcase />
          </Suspense>
        ),
      },
    ]
  : [];
