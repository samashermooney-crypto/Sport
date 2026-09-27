import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, useRoutes } from 'react-router';

import { webFeatures } from './generated/registry';
import { ImpersonationBanner } from './platform/PlatformConsole';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ImpersonationBanner />
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function AppRoutes(): React.ReactNode {
  return useRoutes(webFeatures.flatMap((feature) => [...feature.routes]));
}
