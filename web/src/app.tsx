import { authMeResponseSchema } from '@shared/schemas/auth';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { RouteObject } from 'react-router';
import { BrowserRouter, useLocation, useRoutes } from 'react-router';

import { apiGet } from './api/client';
import { webFeatures } from './generated/registry';
import { i18n } from './lib/i18n';
import { ImpersonationBanner } from './platform/ImpersonationBanner';
import { PlatformShell } from './ui/PlatformShell';
import { RouteLoading } from './ui/RouteLoading';
import { AppErrorBoundary, ToastProvider } from './ui/app-feedback';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <RoutedContent />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function RoutedContent(): React.JSX.Element {
  const location = useLocation();
  return (
    <AppErrorBoundary key={location.pathname}>
      <AuthenticatedLocale path={location.pathname} />
      <ImpersonationBanner />
      {location.pathname.startsWith('/platform') ? (
        <PlatformShell>
          <AppRoutes />
        </PlatformShell>
      ) : (
        <AppRoutes />
      )}
    </AppErrorBoundary>
  );
}

function AuthenticatedLocale({ path }: { path: string }): null {
  const authenticatedArea = /^\/(me|console|orgs|portal|platform)(\/|$)/.test(
    path,
  );
  const account = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiGet('/auth/me', authMeResponseSchema),
    enabled: authenticatedArea,
    retry: false,
  });
  useEffect(() => {
    if (account.data && i18n.resolvedLanguage !== account.data.locale)
      void i18n.changeLanguage(account.data.locale);
  }, [account.data]);
  return null;
}

function AppRoutes(): React.ReactNode {
  const location = useLocation();
  const needsNestedRoutes = /^\/(console|me|orgs|portal|site)(\/|$)/.test(
    location.pathname,
  );
  const [nestedRoutes, setNestedRoutes] = useState<
    readonly RouteObject[] | null
  >(null);
  const [nestedRoutesFailed, setNestedRoutesFailed] = useState(false);

  useEffect(() => {
    if (!needsNestedRoutes || nestedRoutes !== null) return;
    let active = true;
    void import('./generated/nested-routes')
      .then(({ webNestedRoutes }) => {
        if (active) setNestedRoutes(webNestedRoutes);
      })
      .catch(() => {
        if (active) setNestedRoutesFailed(true);
      });
    return () => {
      active = false;
    };
  }, [needsNestedRoutes, nestedRoutes]);

  const routes = useRoutes([
    ...webFeatures.flatMap((feature) => [...feature.routes]),
    ...(nestedRoutes ?? []),
  ]);
  if (needsNestedRoutes && nestedRoutes === null) {
    return nestedRoutesFailed ? (
      <div role="alert">
        <p>Additional pages could not be loaded.</p>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload page
        </button>
      </div>
    ) : (
      <RouteLoading label="Loading page…" />
    );
  }
  return routes;
}
