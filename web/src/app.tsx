import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, useLocation, useRoutes } from 'react-router';

import { webFeatures } from './generated/registry';
import { ImpersonationBanner } from './platform/PlatformConsole';
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
      <ImpersonationBanner />
      <AppRoutes />
    </AppErrorBoundary>
  );
}

function AppRoutes(): React.ReactNode {
  return useRoutes(webFeatures.flatMap((feature) => [...feature.routes]));
}
