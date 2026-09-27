import { authMeResponseSchema } from '@shared/schemas/auth';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, useLocation, useRoutes } from 'react-router';

import { apiGet } from './api/client';
import { webFeatures } from './generated/registry';
import { i18n } from './lib/i18n';
import { ImpersonationBanner } from './platform/PlatformConsole';
import { PlatformShell } from './ui/PlatformShell';
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
  return useRoutes(webFeatures.flatMap((feature) => [...feature.routes]));
}
